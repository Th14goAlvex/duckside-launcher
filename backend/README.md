# API e ponte Duckside — início

## Executar localmente

Use Node.js 24 ou superior. No diretório `backend`, configure `PUBLIC_BASE_URL` com um endpoint HTTPS publicamente acessível e execute `node server.mjs`. A autenticação Steam OpenID precisa conseguir retornar a esse endereço; `localhost` não serve como URL de retorno da Steam.

Exemplo de ambiente de produção:

```text
NODE_ENV=production
PORT=3040
PUBLIC_BASE_URL=https://api.seudominio.com
DUCKSIDE_BRIDGE_KEY=<segredo aleatório longo>
DUCKSIDE_ADMIN_STEAM_IDS=<SteamID64 do administrador>,<outro SteamID64>
DUCKSIDE_ALLOWED_ORIGIN=*
```

O backend cria `data/accounts.sqlite` automaticamente. Preserve esse arquivo e sua pasta em backups seguros; ele contém SteamID, nome de usuário e somente hashes de senha. Senhas são derivadas com scrypt; tokens de sessão não são gravados em claro e expiram em 30 dias. Use HTTPS no proxy reverso, limite acesso ao volume do banco e não publique o arquivo SQLite.

O cadastro exige autenticação OpenID no domínio oficial da Steam, nome de usuário e senha própria do launcher (mínimo 12 caracteres). O banco aplica restrições únicas no nome normalizado e SteamID: o mesmo Steam só pode vincular uma conta Duckside. Login usa nome/senha; a senha Steam nunca é solicitada. As sessões ficam no cliente apenas em memória e precisam ser renovadas ao reabrir o launcher.

Administradores também criam conta normal vinculada ao Steam. Para conceder acesso ao painel, inclua o SteamID64 na variável `DUCKSIDE_ADMIN_STEAM_IDS` e reinicie a API. O cliente não pode conceder esse papel por alteração de código.

Na versão atual, o painel de edição local fica aberto para facilitar os testes; essas mudanças só ficam naquele computador. Uploads de mídia, publicações e atualizações continuam exigindo uma sessão admin aceita pelo backend.

Para executar apenas as rotas públicas localmente sem Steam OpenID, basta `node server.mjs`; cadastros ficam desativados enquanto `PUBLIC_BASE_URL` estiver vazio. A autenticação Steam completa só pode ser testada depois de disponibilizar o callback HTTPS.

O launcher consulta `http://localhost:3040/v1/public/servers/duckside-rp/status` a cada 15 segundos em modo de desenvolvimento. Sem API ligada, mostra o servidor offline.

## Ponte do servidor

O serviço instalado no host do Project Zomboid deve enviar um heartbeat com a chave de ponte, nunca disponibilizar RCON para a internet:

```powershell
$headers=@{'X-Bridge-Key'='SUA_CHAVE';'Content-Type'='application/json'}
$body=@{name='Duckside RP 3D';online=$true;playerCount=42;maxPlayers=250;pingMs=31}|ConvertTo-Json
Invoke-RestMethod -Uri 'https://api.seudominio.com/v1/bridge/heartbeat' -Method Post -Headers $headers -Body $body
```

Em produção, o heartbeat requer `DUCKSIDE_BRIDGE_KEY`. Nunca exponha RCON à internet.

## Publicar novidades e atualizações

Administradores autenticados podem criar, editar e excluir novidades por `POST /v1/admin/news` e `DELETE /v1/admin/news/:id`. Uma notícia pode incluir imagem ou vídeo e a opção `showOnOpen`; cada instalação do launcher marca o aviso como visto depois de exibi-lo, e o jogador pode pular/fechar ou ir para Notícias. Arquivos são enviados em fluxo por `POST /v1/admin/media/news` (imagens até 8 MB, MP4/WebM até 100 MB) e servidos em `/v1/public/media/news/:arquivo` com suporte a requisições parciais para vídeo.

O vídeo de fundo é opcional. Envie MP4/WebM por `POST /v1/admin/media/background`; o caminho é salvo em `content.homeBackgroundVideo` e o app o reproduz em loop, sem áudio. Remover pelo launcher limpa essa configuração. Arquivos antigos de mídia não referenciados não são removidos automaticamente.

O launcher Electron consulta `latest.yml` ao abrir. Uma versão do aplicativo é publicada enviando juntos para `POST /v1/admin/updates/launcher/:arquivo` o instalador `.exe`, o arquivo `latest.yml` e o `.blockmap` gerados pelo builder; o YAML deve ser enviado por último. O serviço entrega esses arquivos em `/v1/public/updates/launcher/`.

As versões do launcher precisam ser assinadas por um certificado Authenticode. O auto-updater mantém a checagem de assinatura ativa e usa o nome do certificado no pacote. O primeiro instalador atual é sem assinatura; a atualização automática segura só poderá ser usada depois de configurar um certificado, gerar uma versão inicial assinada e publicar os artefatos. Nunca desative a checagem de assinatura.

Pacotes de mods/conteúdo `.zip` podem ser enviados para `/v1/admin/updates/content/:arquivo`. O download é disponibilizado ao launcher. A instalação no diretório de mods do jogo depende do manifesto do pacote e da integração com Steam/executor; o upload não os instala sozinho.

## Personagens

`POST /v1/bridge/players/` recebe um SteamID e uma lista de personagens. A futura integração do servidor/mod enviará nome, profissão, status e URL da imagem/modelo; o launcher somente exibe o que a API autorizar para a conta vinculada.
