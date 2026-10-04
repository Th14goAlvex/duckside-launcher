# Contribuindo

Obrigado por ajudar com o Duckside Launcher. Para manter as mudanças fáceis de revisar:

1. Abra uma issue descrevendo o problema ou a proposta antes de uma mudança grande.
2. Faça uma alteração focada e explique como testou.
3. Rode `npm run check` e `node --check backend/server.mjs` quando alterar a API.
4. Nunca inclua tokens, Steam tickets, senhas, bancos locais, arquivos `.env` ou dados reais de jogadores.
5. Não afrouxe verificações de autorização no backend para contornar bloqueios da interface.

Envie a proposta por pull request. A equipe revisará segurança, compatibilidade com o Project Zomboid e impacto na comunidade antes de integrar.
