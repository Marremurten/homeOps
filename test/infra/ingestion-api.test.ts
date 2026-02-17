import { describe, it, expect, beforeAll } from "vitest";
import { App, Stack } from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { IngestionApi } from "../../infra/constructs/ingestion-api.js";

describe("IngestionApi construct", () => {
  let template: Template;

  beforeAll(() => {
    const app = new App();
    const stack = new Stack(app, "TestStack");
    const queue = new sqs.Queue(stack, "TestQueue");
    const secret = new secretsmanager.Secret(stack, "TestSecret");
    new IngestionApi(stack, "TestApi", { queue, webhookSecret: secret });
    template = Template.fromStack(stack);
  });

  it("creates an HTTP API", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
      ProtocolType: "HTTP",
    });
  });

  describe("Ingest Lambda function", () => {
    it("uses nodejs22.x runtime", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        Runtime: "nodejs22.x",
        Handler: Match.anyValue(),
      });
    });

    it("uses arm64 architecture", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        Architectures: ["arm64"],
      });
    });

    it("has 10 second timeout", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        Timeout: 10,
      });
    });

    it("has 256 MB memory", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        MemorySize: 256,
      });
    });
  });

  describe("Health Lambda function", () => {
    it("uses nodejs22.x runtime", () => {
      // There should be at least 2 Lambda functions (ingest + health)
      const lambdas = template.findResources("AWS::Lambda::Function", {
        Properties: {
          Runtime: "nodejs22.x",
        },
      });
      expect(Object.keys(lambdas).length).toBeGreaterThanOrEqual(2);
    });

    it("uses arm64 architecture", () => {
      const lambdas = template.findResources("AWS::Lambda::Function", {
        Properties: {
          Architectures: ["arm64"],
        },
      });
      expect(Object.keys(lambdas).length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("API routes", () => {
    it("has a POST /webhook route", () => {
      template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
        RouteKey: "POST /webhook",
      });
    });

    it("has a GET /health route", () => {
      template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
        RouteKey: "GET /health",
      });
    });
  });

  describe("Ingest Lambda environment variables", () => {
    it("has SQS_QUEUE_URL environment variable", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        Environment: {
          Variables: {
            SQS_QUEUE_URL: Match.anyValue(),
          },
        },
      });
    });

    it("has WEBHOOK_SECRET_ARN environment variable", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        Environment: {
          Variables: {
            WEBHOOK_SECRET_ARN: Match.anyValue(),
          },
        },
      });
    });
  });

  describe("Ingest Lambda IAM permissions", () => {
    it("has sqs:SendMessage permission on the queue", () => {
      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.anyValue(),
              Effect: "Allow",
              Resource: Match.anyValue(),
            }),
          ]),
        },
      });

      // Verify sqs:SendMessage specifically
      const policies = template.findResources("AWS::IAM::Policy");
      const hasSqsPermission = Object.values(policies).some((policy: any) => {
        const statements =
          policy.Properties?.PolicyDocument?.Statement ?? [];
        return statements.some((stmt: any) => {
          const actions = Array.isArray(stmt.Action)
            ? stmt.Action
            : [stmt.Action];
          return actions.some(
            (a: string) => a === "sqs:SendMessage" || a === "sqs:*",
          );
        });
      });
      expect(hasSqsPermission).toBe(true);
    });

    it("has secretsmanager:GetSecretValue permission on the secret", () => {
      const policies = template.findResources("AWS::IAM::Policy");
      const hasSecretsPermission = Object.values(policies).some(
        (policy: any) => {
          const statements =
            policy.Properties?.PolicyDocument?.Statement ?? [];
          return statements.some((stmt: any) => {
            const actions = Array.isArray(stmt.Action)
              ? stmt.Action
              : [stmt.Action];
            return actions.some(
              (a: string) =>
                a === "secretsmanager:GetSecretValue" || a === "secretsmanager:*",
            );
          });
        },
      );
      expect(hasSecretsPermission).toBe(true);
    });
  });

  describe("Health Lambda environment variables", () => {
    it("has DEPLOY_VERSION environment variable", () => {
      const lambdas = template.findResources("AWS::Lambda::Function", {
        Properties: {
          Environment: {
            Variables: {
              DEPLOY_VERSION: Match.anyValue(),
            },
          },
        },
      });
      expect(Object.keys(lambdas).length).toBeGreaterThanOrEqual(1);
    });
  });
});
