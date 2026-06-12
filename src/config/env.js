const fs = require('fs');
const path = require('path');

// Manually load .env variables from the backend folder into process.env
const envPath = path.join(__dirname, '../../.env');
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf8');
  content.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const firstEq = trimmed.indexOf('=');
    if (firstEq === -1) return;
    const key = trimmed.substring(0, firstEq).trim();
    let val = trimmed.substring(firstEq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    // Only set if not already set by external process parameters
    if (!process.env[key]) {
      process.env[key] = val;
    }
  });
}

const { z } = require('zod');

// Schema for environment configuration validation
const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  MONGO_URI: z.string({
    required_error: 'MONGO_URI is required to connect to the database.',
  }).url('MONGO_URI must be a valid MongoDB connection string.'),
  JWT_SECRET: z.string({
    required_error: 'JWT_SECRET is required to secure authentication tokens.',
  }).min(16, 'JWT_SECRET should be at least 16 characters long for security.'),
  JWT_REFRESH_SECRET: z.string({
    required_error: 'JWT_REFRESH_SECRET is required to rotate authentication sessions securely.',
  }).min(16, 'JWT_REFRESH_SECRET should be at least 16 characters long.'),
  MFA_ISSUER: z.string().default('ByoSync Admin Portal'),
  // Vertex AI auth
  //   Local: ambient ADC (gcloud auth application-default login) — no env var needed.
  //   Vercel: set GOOGLE_APPLICATION_CREDENTIALS_JSON to the full ADC JSON
  //           (type: "authorized_user" — the user OAuth2 credential from
  //            C:\Users\khatr\AppData\Roaming\gcloud\application_default_credentials.json).
  //           The bootstrap IIFE in llmController.js writes it to a temp file.
  GOOGLE_APPLICATION_CREDENTIALS_JSON: z.string().optional(),
  VERTEX_PROJECT: z.string().default('compliance-app-498606'),
  VERTEX_LOCATION: z.string().default('us-central1'),
  OPENAI_API_KEY: z.string().optional(),
  TOKEN_BUDGET_PER_SCAN: z.coerce.number().default(100000),
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
  console.error('❌ Invalid Environment Configuration:');
  console.error(JSON.stringify(result.error.format(), null, 2));
  process.exit(1); // Exit process immediately
}

module.exports = result.data;
