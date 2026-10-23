# NEXUS AI — Railway Flat Edition
All project files intentionally live in the repository root. No source folders are required.

## Deploy
1. Create a GitHub repository and upload every file here to the repository root.
2. In Railway: New Project → Deploy from GitHub Repo.
3. Add a PostgreSQL service. Railway supplies `DATABASE_URL`.
4. Add variables from `.env.example`. Never commit real secrets.
5. Run `npx prisma db push` once (Railway shell or pre-deploy command).
6. Set `APP_URL` to your Railway public HTTPS URL.
7. Google callback: `APP_URL/auth/google/callback`. GitHub callback: `APP_URL/auth/github/callback`.

## Owner
Sign in normally, then send your configured OWNER_CODE as a chat message. The server stores OWNER role on that signed-in account and does not send that code to the AI. Choose a long unique secret.

## Important
The local upload endpoint is intentionally limited to 25 MB. Multi-GB uploads should use object storage multipart uploads (S3/R2), not Railway disk or GitHub.
