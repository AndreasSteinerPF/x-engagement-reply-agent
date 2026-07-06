set dotenv-load := false

# Install dependencies
setup:
    npm ci

# Check code formatting
format:
    npx prettier --check .

# Run linting
lint:
    npx eslint .

# Run type checking
type-check:
    npx tsc --noEmit

# Run tests
test:
    npx vitest run

# Synthesize CDK stack
build:
    npx cdk synth --strict

# Deploy CDK stack
deploy:
    npx cdk deploy --require-approval never
