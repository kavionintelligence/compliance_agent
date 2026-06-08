# ByoSync Compliance Agent — Admin Portal & API

Connected SaaS backend and administrator console for the ByoSync Compliance Agent.

## What's included

- **Admin Portal** — web console at `/admin`
- **REST API** — `/api/v1/*` (auth, scans, admin operations, config)
- **MongoDB** — user data, scan telemetry, audit logs

## Local development

```bash
npm install
cp .env.example .env   # fill in your values
npm run dev
```

Open [http://localhost:3000/admin](http://localhost:3000/admin).

## Deploy to Vercel

1. Push this repo to GitHub.
2. Import the project in [Vercel](https://vercel.com/new).
3. Set **Root Directory** to `.` (repo root).
4. Add environment variables from `.env.example` in the Vercel project settings:
   - `MONGO_URI`
   - `JWT_SECRET`
   - `JWT_REFRESH_SECRET`
   - `NODE_ENV=production`
   - Optional: `GEMINI_API_KEY`, `OPENAI_API_KEY`
5. Deploy.

After deploy, open `https://<your-project>.vercel.app/admin`.

> **Note:** Real-time Socket.io features (live support chat) require a persistent Node server (e.g. Railway or Render). REST API and the admin dashboard work on Vercel.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MONGO_URI` | Yes | MongoDB connection string |
| `JWT_SECRET` | Yes | Access token signing secret (16+ chars) |
| `JWT_REFRESH_SECRET` | Yes | Refresh token signing secret (16+ chars) |
| `NODE_ENV` | No | `production` in Vercel |
| `PORT` | No | Defaults to 3000 (Vercel sets this automatically) |
