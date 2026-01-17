# Veilpay Relayer Infra

## Prereqs
- `VULTR_API_KEY` set in your shell
- `terraform` installed
- SSH access with key ``

## Defaults
- region: `sea`
- plan: `vc2-1c-2gb`
- os: Ubuntu 24.04 (`os_id = 2284`)
- port: `8080`
- rpc: `https://api.devnet.solana.com`
- allowed origins: `*`

## Customize
```
terraform -chdir=infra/relayer apply \
  -var 'region=sea' \
  -var 'plan=vc2-1c-2gb' \
  -var 'os_id=2284' \
  -var 'ssh_key_id=' \
  -var 'relayer_allowed_origins=https://your-app.vercel.app'
```
