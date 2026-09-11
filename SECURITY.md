# Security policy

## Public repository rules

This repository contains public contracts, application code, calculation logic, tests and documentation

It must never contain private keys, wallet seed phrases, RPC credentials, API keys, server passwords, SSH private keys, private admin URLs or live bot state

Secrets belong only in ignored environment files or the production server secret store

Run the following check before every public push

```bash
npm run security:secrets
```

The same check runs automatically for every GitHub push and pull request

## Reporting a vulnerability

Do not publish an exploit or a leaked credential in a public issue

Use the private security reporting channel configured in the GitHub repository settings
