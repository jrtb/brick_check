#!/usr/bin/env bash
set -euo pipefail

# Deploy static site to S3 using your currently logged-in AWS CLI credentials.
# Usage: ./deploy.sh <s3-bucket-name> [aws-region]

if [[ ${1-} == "" ]]; then
  echo "Usage: $0 <s3-bucket-name> [aws-region]"
  exit 1
fi

BUCKET="$1"
REGION="${2-}"

if [[ -n "$REGION" ]]; then
  export AWS_REGION="$REGION"
fi

echo "Deploying to s3://$BUCKET ..."

# Ensure the bucket exists (idempotent if already exists and owned by you)
if ! aws s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
  echo "Creating bucket $BUCKET ..."
  if [[ -n "$REGION" && "$REGION" != "us-east-1" ]]; then
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" --create-bucket-configuration LocationConstraint="$REGION"
  else
    aws s3api create-bucket --bucket "$BUCKET"
  fi
fi

# Enable static website hosting and set index/error docs
aws s3 website "s3://$BUCKET" --index-document index.html --error-document index.html || true

# Public read policy for website hosting (optional). Comment out if using CloudFront with OAC.
WEBSITE_POLICY=$(cat <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadGetObject",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::__BUCKET__/*"
    }
  ]
}
JSON
)

WEBSITE_POLICY=${WEBSITE_POLICY/__BUCKET__/$BUCKET}
aws s3api put-bucket-policy --bucket "$BUCKET" --policy "$WEBSITE_POLICY" || true

# Sync files with sensible cache headers
aws s3 sync . "s3://$BUCKET" \
  --exclude ".git/*" \
  --exclude ".github/*" \
  --exclude "deploy.sh" \
  --delete \
  --cache-control "public,max-age=600"

# Correct content types for common assets
aws s3 cp index.html "s3://$BUCKET/index.html" --cache-control "public,max-age=60" --content-type "text/html; charset=utf-8"
aws s3 cp styles.css "s3://$BUCKET/styles.css" --cache-control "public,max-age=3600" --content-type "text/css; charset=utf-8"
aws s3 cp app.js "s3://$BUCKET/app.js" --cache-control "public,max-age=600" --content-type "application/javascript; charset=utf-8"

echo "Done. Website endpoint: http://$BUCKET.s3-website-${AWS_REGION:-us-east-1}.amazonaws.com"


