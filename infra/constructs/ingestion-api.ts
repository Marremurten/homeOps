import * as cdk from "aws-cdk-lib";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as lambda from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambdaRuntime from "aws-cdk-lib/aws-lambda";
import { HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { Construct } from "constructs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface IngestionApiProps {
  queue: sqs.IQueue;
  webhookSecret: secretsmanager.ISecret;
}

export class IngestionApi extends Construct {
  public readonly api: HttpApi;

  constructor(scope: Construct, id: string, props: IngestionApiProps) {
    super(scope, id);

    this.api = new HttpApi(this, "HttpApi");

    const ingestFn = new lambda.NodejsFunction(this, "IngestFn", {
      runtime: lambdaRuntime.Runtime.NODEJS_22_X,
      architecture: lambdaRuntime.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      entry: path.join(__dirname, "../../src/handlers/ingest/index.ts"),
      handler: "handler",
      environment: {
        SQS_QUEUE_URL: props.queue.queueUrl,
        WEBHOOK_SECRET_ARN: props.webhookSecret.secretArn,
      },
    });

    const healthFn = new lambda.NodejsFunction(this, "HealthFn", {
      runtime: lambdaRuntime.Runtime.NODEJS_22_X,
      architecture: lambdaRuntime.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      entry: path.join(__dirname, "../../src/handlers/health/index.ts"),
      handler: "handler",
      environment: {
        DEPLOY_VERSION: "0.0.0",
      },
    });

    this.api.addRoutes({
      path: "/webhook",
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration("IngestIntegration", ingestFn),
    });

    this.api.addRoutes({
      path: "/health",
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration("HealthIntegration", healthFn),
    });

    props.queue.grantSendMessages(ingestFn);
    props.webhookSecret.grantRead(ingestFn);
  }
}
