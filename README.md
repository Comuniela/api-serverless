api-serverless

# Local testing
sls offline

# Deploy to staging
sls deploy

# Deploy to production
sls deploy --stage prod --env production

# Deploy only one function
sls deploy function --f user