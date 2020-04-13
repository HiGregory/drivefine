import {
  APIGatewayProxyHandler
} from 'aws-lambda';
import 'source-map-support/register';
import * as Knex from 'knex';
import {
  Model,
  knexSnakeCaseMappers
} from 'objection';

import {
  browardCountyCDLCheck
} from './lib/functions/browardCountyCheck';

//Helpers
import {
  validateEmail,
  validatePhoneNumber,
  validateDLSubmission
} from './validators';
import {
  Subscription
} from './models/subscription'
import
DriverLicense
from './models/driverLicense';

import {
  sendEnrollmentConfirmation,
  sendReportSMS,
  lookupPhoneNumber
} from './lib/functions/twilio';


// TYPES
import {
  SubscriptionRequest
} from './subscription';

import {
  Notification
} from './models/notification';

const knexConfig = require('./knexfile');


const knex = Knex({
  ...knexConfig,
  ...knexSnakeCaseMappers()
});

Model.knex(knex);


export const migrate: APIGatewayProxyHandler = async (event, _context) => {
  await knex.migrate.latest(knexConfig);

  return {
    statusCode: 200,
    body: JSON.stringify({
      message: 'Migration Ran',
      input: event,
    }, null, 2),
  };
}

/**
 * @param {string} dlNumber - Florida driverLicense For Miami Dade Selections
 * @returns {string} - success or error
 */
export const rundlReports: APIGatewayProxyHandler = async (_, _context) => {
  // log starting
  // log number of subs
  // log number of DL reports found vs making
  // TODO switch to momment
  const thirtyDaysAgo = new Date(new Date().setDate(new Date().getDate() - 30));

  // get all valid Subscriptions with no notification in the last 30 days 
  // what if no notification but drivers report is last 30? 
  const validSubscriptions = await Subscription.query().where('unsubscribedOn', null);
  // extract just DL ids and transform to set for just unique values to reduce in unessecary addtional queries.


  // REWRITE THIS BIT 
  /*
      TODO
      find all subscriptions that don't have a dlreport sent to them in the last 30 days. (MAX ID is prob going to be best, but make sure to grab the row seperatly or make sure postgresql doesn't have this issue)
      per subscription, send the DL message ** this will mean redundant DL checks, but thats not a real problem right now.
      SO we track the report being run for that subscription, and track the message
      so send message, if message is sent, add to report, if not report and return with error.
      ALSO update report model/DB changes alls
  */
  for (const sub of validSubscriptions) {
    // most recent notification for that sub ID gotta use MAX here instead
    const lastNotification = await Notification.query().where('driverLicenseId', sub.driverLicenseId).orderBy('createdOn', 'desc').where('createdOn', '>=', thirtyDaysAgo).first();
    if (!lastNotification) {
      try {
        const driverLicense = await DriverLicense.query().where('id', sub.driverLicenseId).first();
        const {
          reportInnerText
        } = await browardCountyCDLCheck(driverLicense.driverLicenseNumber);

        const message = await sendReportSMS(sub.phoneNumber, driverLicense.driverLicenseNumber, reportInnerText, 'Broward County Clerk Of Courts');

        const messageResult = message[0];

        delete messageResult.body;

        // we need to make this much more bomb proof (make more columns optional) incase something happens.
        await Notification.query().insert({
          driverLicenseId: sub.driverLicenseId,
          contactMethod: 'SMS',
          subscriptionId: sub.id,
          notificationRequestResponse: messageResult,
          county: sub.county,
          status: messageResult.status
        });
      } catch (error) {
        // alert on these errors but don't halt thread cause we'll have to keep going
        console.error(`unable to process subId ${sub.id}`);
        console.error(error);
      }
    }
  }
  return {
    statusCode: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': true,
    },
    // include number and some subscription ids?
    body: 'Reports run',
  };
}

export const subscription: APIGatewayProxyHandler = async (event, _context) => {
  const subscriptionRequest: SubscriptionRequest = JSON.parse(event.body);
  const {
    emailAddressClient,
    phoneNumberClient,
    driverLicenseIdClient,
    countyClient
  } = subscriptionRequest;
  if (typeof emailAddressClient !== 'string' || typeof driverLicenseIdClient !== "string" || typeof countyClient !== "string" || typeof phoneNumberClient !== "string") {
    return {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true,
      },
      statusCode: 400,
      // move to http error handling
      body: 'BAD REQUEST'
    };
  }
  try {
    console.dir(`starting validation`);
    const emailAddress = validateEmail(emailAddressClient);
    const {phoneNumber} = await lookupPhoneNumber(phoneNumberClient);
    
    validatePhoneNumber(phoneNumber);

    const {
      county,
      driverLicenseNumber
    } = validateDLSubmission(driverLicenseIdClient, countyClient);
    console.dir(`client validation ended`);
    // TODO upsert  (adjust for concurrency). INSPO https://gist.github.com/derhuerst/7b97221e9bc4e278d33576156e28e12d
    // TODO sanitaize return values from DB with try catch
    let driverLicense = await DriverLicense.query().where('driverLicenseNumber', driverLicenseNumber).first()

    if (driverLicense) {
      const existingSubscription = await Subscription.query().where({
        emailAddress,
        phoneNumber,
        driverLicenseId: driverLicense.id
      }).first();

      if (driverLicense.disabled || existingSubscription) {
        return {
          statusCode: 409,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Credentials': true,
          },
          body: JSON.stringify({
            message: 'This is a duplicate Subscription in our system. Please reach out to support@drivefine.com if you belive this is an Error'
          }),
        };
      }
    } else {
      driverLicense = await DriverLicense.query().insert({
        driverLicenseNumber,
        county,
        disabled: false
      });
    }


    // DL isn't found, need to create before moving forward

    const subscription = await Subscription.query().insert({
      emailAddress,
      phoneNumber,
      driverLicenseId: driverLicense.id,
      county,
      createdOn: new Date(),
      subscribedOn: new Date()
    });
    console.dir(`enrolled sending sms`);
    await sendEnrollmentConfirmation(phoneNumberClient, driverLicenseIdClient);

    try {

      const {
        reportInnerText
      } = await browardCountyCDLCheck(driverLicense.driverLicenseNumber);

      const message = await sendReportSMS(phoneNumber, driverLicense.driverLicenseNumber, reportInnerText, 'Broward County Clerk Of Courts');
      const messageResult = message[0];
      delete messageResult.body;

      // TODO handle messge response if error.

      await Notification.query().insert({
        driverLicenseId: subscription.driverLicenseId,
        contactMethod: 'SMS',
        subscriptionId: subscription.id,
        notificationRequestResponse: messageResult,
        county: subscription.county,
        status: messageResult.status
      });

    } catch (error) {
      // log errors and alert better
      console.dir(error);
    }
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true,
      },
      body: JSON.stringify({
        message: 'success'
      }),
    };
  } catch (error) {
    console.error(error);
    return {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true,
      },
      statusCode: 422,
      body: JSON.stringify({
        description: error.message
      }),
    };
  }
};