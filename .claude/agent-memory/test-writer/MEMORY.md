# Test Writer Memory - HomeOps

## Project Overview
- HomeOps: Household intelligence agent, Telegram interface, AWS serverless (CDK)
- Language: TypeScript, ESM, pnpm
- Test framework: Vitest
- Path aliases: `@shared/*` maps to `src/shared/*`

## Test Conventions
- Test files in `test/` directory, mirroring source structure
- Use `import { describe, it, expect } from "vitest"`
- Use dynamic `await import()` for testing module resolution
- For running CLI commands in tests, use `execFileSync` from `node:child_process`
- Security hook blocks shell-based command execution -- always use the file-based variant
- Tests should be behavioral, not implementation-coupled
- Async tests for module imports and subprocess calls

## Project Structure (from plan.md)
- `test/setup.test.ts` - scaffolding smoke tests
- `test/shared/` - shared utility tests
- `test/handlers/` - Lambda handler tests
- `test/infra/` - CDK construct/stack tests
- `test/scripts/` - shell script tests

## Key Files
- Plan: `/docs/features/homeops-p1-infra/plan.md`
- PRD: `/docs/features/homeops-p1-infra/prd.md`
- Research: `/docs/features/homeops-p1-infra/research/SUMMARY.md`

## Shell Test Patterns
- Shell test scripts use `#!/usr/bin/env bash` with `set -euo pipefail`
- Test file location: `test/scripts/<name>.test.sh` for scripts in `scripts/`
- Use pass/fail counters with helper functions for assertions
- When script under test does not exist, exit early with clear "script not found" message
- Test both exit codes AND output content for thorough validation
- Use `PATH="/usr/bin:/bin"` trick to simulate missing CLI tools
- Use `bash -n` to verify test scripts have no syntax errors before running
- Sanity-check tests against a minimal stub to confirm assertions actually fire

## CDK Test Patterns
- Use `Template.fromStack(stack)` with `beforeAll` for synthesizing once
- `template.hasResourceProperties(type, props)` for asserting a resource exists
- `template.findResources(type, { Properties: ... })` to find multiple resources and count them
- `Match.anyValue()` for properties you don't want to pin to a specific value
- `Match.arrayWith([Match.objectLike({...})])` for partial array/object matching
- For IAM permissions: find all `AWS::IAM::Policy` resources and inspect Statement arrays
- For verifying multiple Lambdas: use `findResources` and check `Object.keys().length >= N`
- CDK test imports: `aws-cdk-lib`, `aws-cdk-lib/assertions`, `aws-cdk-lib/aws-*`

## Patterns
- Security hook triggers on mentions of shell-based command execution in any file
- npx vitest is available globally (even without local package.json)
