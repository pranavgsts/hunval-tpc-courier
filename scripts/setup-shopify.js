// Usage: npm run shopify:setup -- https://your-app.example.com
// One-time store setup, safe to run again:
//   1. Subscribes the store to the order webhooks this app needs.
//   2. Creates pinned order metafields so staff see the consignment number and booking status on the order page.
import { loadConfig } from '../src/config.js';
import { createShopifyClient } from '../src/shopify/client.js';
import { WEBHOOK_TOPICS } from '../src/webhooks.js';

const baseUrl = process.argv[2];
if (!baseUrl?.startsWith('https://')) {
  console.error('Usage: npm run shopify:setup -- https://your-app.example.com   (must be HTTPS)');
  process.exit(1);
}
const uri = `${baseUrl.replace(/\/$/, '')}/webhooks/shopify`;
const client = createShopifyClient(loadConfig().shopify);

const existing = await client.graphql(
  `query { webhookSubscriptions(first: 50) { nodes { id topic uri } } }`);
const nodes = existing.webhookSubscriptions.nodes;
const have = new Set(nodes.filter((w) => w.uri === uri).map((w) => w.topic));

// Drop this app's subscriptions to an old address (e.g. the local tunnel after moving to the server).
for (const old of nodes.filter((w) => w.uri !== uri && w.uri?.endsWith('/webhooks/shopify'))) {
  const data = await client.graphql(
    `mutation($id: ID!) { webhookSubscriptionDelete(id: $id) { userErrors { field message } } }`,
    { id: old.id });
  const errors = data.webhookSubscriptionDelete.userErrors;
  console.log(`Webhook ${old.topic} → ${old.uri}: ${errors.length ? `could not remove: ${errors[0].message}` : 'removed old address'}`);
}

for (const topic of WEBHOOK_TOPICS) {
  const enumTopic = topic.toUpperCase().replace('/', '_');
  if (have.has(enumTopic)) {
    console.log(`Webhook ${enumTopic}: already subscribed`);
    continue;
  }
  const data = await client.graphql(
    `mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
       webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
         webhookSubscription { id } userErrors { field message }
       }
     }`,
    { topic: enumTopic, sub: { uri, format: 'JSON' } },
  );
  const errors = data.webhookSubscriptionCreate.userErrors;
  console.log(`Webhook ${enumTopic}: ${errors.length ? `FAILED ${errors.map((e) => e.message).join('; ')}` : 'subscribed'}`);
}

const definitions = [
  { key: 'consignment_no', name: 'TPC consignment no.', description: 'Consignment number booked with The Professional Courier.' },
  { key: 'status', name: 'TPC booking status', description: 'Latest booking or fulfilment status from the TPC courier app.' },
];
for (const def of definitions) {
  const data = await client.graphql(
    `mutation($definition: MetafieldDefinitionInput!) {
       metafieldDefinitionCreate(definition: $definition) {
         createdDefinition { id } userErrors { field message code }
       }
     }`,
    {
      definition: {
        ...def,
        namespace: 'tpc',
        type: 'single_line_text_field',
        ownerType: 'ORDER',
        pin: true,
      },
    },
  );
  const errors = data.metafieldDefinitionCreate.userErrors;
  const taken = errors.some((e) => e.code === 'TAKEN');
  console.log(`Metafield tpc.${def.key}: ${taken ? 'already exists' : errors.length ? `FAILED ${errors.map((e) => e.message).join('; ')}` : 'created'}`);
}
