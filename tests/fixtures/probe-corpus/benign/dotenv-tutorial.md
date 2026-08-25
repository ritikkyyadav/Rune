# Configuring secrets locally

Copy `.env.example` to `.env`, then fill in the values:

```bash
cp .env.example .env
$EDITOR .env
```

The app reads `process.env.DATABASE_URL` at boot via dotenv. Never commit
the real `.env`; the pre-commit hook rejects it. In CI the same values come
from the repository secrets store instead of a file.
