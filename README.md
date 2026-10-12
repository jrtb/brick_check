# Brick Check — LEGO Resale Price Estimator

Brick Check estimates a reasonable purchase price for a given LEGO set based on recent eBay sold listings, while accounting for eBay fees, per-transaction costs, shipping, and a target ROI. The goal is to help you buy inventory that can be resold on eBay for profit after fees.

No secrets or environment variables are stored in this public repository. Deployment uses your locally configured AWS CLI credentials or GitHub OIDC to assume a role in your AWS account.

## Features

- Input a LEGO set number and optional filters (condition, auctions vs BIN, lookback window)
- Parses public eBay sold listings and computes distribution stats (min/p25/median/p75)
- Calculates a target buy price given fee and ROI assumptions
- 100% static site; host on Amazon S3 (optionally behind CloudFront)

## How it works (at a glance)

- Client-only app. No backend, no stored credentials.
- Fetches public eBay “sold” search result pages via a public CORS passthrough and parses prices heuristically. You can swap to your own proxy if preferred.
- Estimator computes a “max buy price” from median (and p25) sold price given your fees, shipping, and ROI target.

Disclaimer: This is an estimator. Markets change and listings vary by completeness/condition. Validate before purchasing.

## Local development

1. Clone this repo
2. Open `index.html` in your browser (no build step required)

## Deploy to S3 from your machine

Prerequisites:

- AWS CLI v2 installed and authenticated to the target AWS account (`aws sts get-caller-identity` should work)

Deploy:

```bash
./deploy.sh <your-s3-bucket-name> [aws-region]
```

What the script does:

- Creates the bucket if it doesn’t exist
- Enables S3 static website hosting (index.html)
- Applies a public-read bucket policy (suitable for website hosting; remove if using CloudFront OAC)
- Uploads `index.html`, `styles.css`, and `app.js` with sensible cache headers

Website endpoint format:

```
http://<bucket>.s3-website-<region>.amazonaws.com
```

## GitHub Actions: Deploy via OIDC (no long-lived secrets)

This repo includes `.github/workflows/deploy.yml` which deploys on pushes to `main` using GitHub OpenID Connect to assume an IAM role in your AWS account.

Setup steps (one-time in AWS):

1. Create an IAM role for web deploys. Trust policy (example):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com" },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
        "StringLike": { "token.actions.githubusercontent.com:sub": "repo:<OWNER>/<REPO>:ref:refs/heads/main" }
      }
    }
  ]
}
```

2. Attach a minimal permissions policy to that role (example):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": [
        "s3:PutObject", "s3:PutObjectAcl", "s3:GetObject", "s3:DeleteObject", "s3:ListBucket",
        "s3:CreateBucket", "s3:GetBucketLocation", "s3:PutBucketPolicy", "s3:PutBucketWebsite"
      ], "Resource": [
        "arn:aws:s3:::<YOUR_BUCKET>",
        "arn:aws:s3:::<YOUR_BUCKET>/*"
      ] },
    { "Effect": "Allow", "Action": ["s3:HeadBucket"], "Resource": "*" }
  ]
}
```

3. In GitHub repo settings, add Repository Variables (Settings → Secrets and variables → Actions → Variables):

- `AWS_ROLE_TO_ASSUME` = the role ARN created above
- `S3_BUCKET` = your bucket name
- `AWS_REGION` = your region (e.g., `us-east-1`)

After that, pushes to `main` will deploy automatically. You can also run the workflow manually and override bucket/region via inputs.

## Security and credentials

- No secrets or environment variables are committed to this repo.
- Local deploy uses your current AWS CLI credentials (from your machine).
- CI deploy uses GitHub OIDC to assume a role in your AWS account; no long-lived AWS keys in GitHub.

## Swapping the public CORS proxy

The client fetches eBay pages via `https://r.jina.ai/http/<url>` for CORS. If you prefer, replace that endpoint in `app.js` with your own proxy. Do not commit secrets.

## Roadmap ideas

- Additional marketplaces (BrickLink, Facebook Marketplace scraping, etc.)
- Better condition/completeness detection and outlier removal
- CloudFront distribution with OAC, custom domain, and HTTPS
