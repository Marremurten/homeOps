import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

export class MessageStore extends Construct {
  public readonly messagesTable: dynamodb.Table;
  public readonly homeopsTable: dynamodb.Table;
  public readonly activitiesTable: dynamodb.Table;
  public readonly responseCountersTable: dynamodb.Table;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.messagesTable = new dynamodb.Table(this, "MessagesTable", {
      tableName: "homeops-messages",
      partitionKey: { name: "chatId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "messageId", type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      timeToLiveAttribute: "ttl",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.homeopsTable = new dynamodb.Table(this, "HomeopsTable", {
      tableName: "homeops",
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.homeopsTable.addGlobalSecondaryIndex({
      indexName: "gsi1",
      partitionKey: { name: "gsi1pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "gsi1sk", type: dynamodb.AttributeType.STRING },
    });

    this.activitiesTable = new dynamodb.Table(this, "ActivitiesTable", {
      tableName: "homeops-activities",
      partitionKey: { name: "chatId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "activityId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.activitiesTable.addGlobalSecondaryIndex({
      indexName: "userId-timestamp-index",
      partitionKey: { name: "userId", type: dynamodb.AttributeType.NUMBER },
      sortKey: { name: "timestamp", type: dynamodb.AttributeType.NUMBER },
    });

    this.responseCountersTable = new dynamodb.Table(
      this,
      "ResponseCountersTable",
      {
        tableName: "homeops-response-counters",
        partitionKey: { name: "chatId", type: dynamodb.AttributeType.STRING },
        sortKey: { name: "date", type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        pointInTimeRecovery: true,
        timeToLiveAttribute: "ttl",
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      },
    );
  }
}
