#!/usr/bin/env node
// Mint un token client a envoyer par mail. Usage : npm run mint -- "Nom du client"
import { mintToken, listTokens } from "../src/store.mjs";

const client = process.argv.slice(2).join(" ").trim();
if (!client) {
  const all = await listTokens();
  console.log(`Usage: npm run mint -- "Nom du client"\n`);
  console.log(`Tokens existants (${all.length}) :`);
  for (const t of all) console.log(`  ${t.client.padEnd(24)} ${t.token}`);
  process.exit(all.length ? 0 : 1);
}

const token = await mintToken(client);
console.log(`\nToken cree pour "${client}" :\n`);
console.log(`  ${token}\n`);
console.log(`A envoyer au client. Il le met dans son connecteur MCP :`);
console.log(`  URL    : https://mcp.stacko.fr/mcp`);
console.log(`  Header : Authorization: Bearer ${token}\n`);
