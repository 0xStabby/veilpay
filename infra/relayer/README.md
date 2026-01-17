# Veilpay Relayer Infra

## Prereqs
- `VULTR_API_KEY` set in your shell
- `terraform` installed
- SSH access with key `651d234b-8803-4f0e-a632-845d0db6c54a`

## Defaults
- region: `sea`
- plan: `vc2-1c-2gb`
- os: Ubuntu 24.04 (`os_id = 2284`)
- port: `8080`
- rpc: `https://betty-1cgsj3-fast-devnet.helius-rpc.com`
- allowed origins: `*`

## Customize
```
terraform -chdir=infra/relayer apply \
  -var 'region=sea' \
  -var 'plan=vc2-1c-2gb' \
  -var 'os_id=2284' \
  -var 'ssh_key_id=651d234b-8803-4f0e-a632-845d0db6c54a' \
  -var 'relayer_allowed_origins=https://your-app.vercel.app'
```
