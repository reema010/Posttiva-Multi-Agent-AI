# Security Notes

- Never commit `.env` files or API/database/SMTP credentials.
- If credentials were ever exposed in a public repository, revoke/rotate them immediately; removing a file from the latest commit is not sufficient because Git history may retain it.
- Use provider-specific secret managers or repository secrets for deployed environments.
