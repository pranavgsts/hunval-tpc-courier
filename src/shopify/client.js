const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Shopify sometimes answers with a full HTML page; keep log lines readable.
async function shortBody(response) {
  return (await response.text()).replace(/\s+/g, ' ').slice(0, 300);
}

/**
 * Minimal GraphQL Admin API client. Uses a static token when one is configured,
 * otherwise the client-credentials grant (Dev Dashboard app installed on a store in
 * the same organization); those tokens last 24 hours and are cached here.
 */
export function createShopifyClient({ shop, clientId, clientSecret, apiVersion, accessToken }) {
  const host = `${shop}.myshopify.com`;
  let token = accessToken || null;
  let tokenExpiresAt = accessToken ? Infinity : 0;

  async function getToken() {
    if (token && Date.now() < tokenExpiresAt - 60_000) return token;
    const response = await fetch(`https://${host}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
    });
    if (!response.ok) {
      throw new Error(`Shopify token request failed: HTTP ${response.status} ${await shortBody(response)}`);
    }
    const data = await response.json();
    token = data.access_token;
    tokenExpiresAt = Date.now() + (Number(data.expires_in) || 86_400) * 1000;
    return token;
  }

  async function graphql(query, variables = {}, attempt = 1) {
    const response = await fetch(`https://${host}/admin/api/${apiVersion}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await getToken() },
      body: JSON.stringify({ query, variables }),
    });

    if (response.status === 401 && !accessToken && attempt === 1) {
      tokenExpiresAt = 0;
      return graphql(query, variables, attempt + 1);
    }
    if ((response.status === 429 || response.status >= 500) && attempt < 5) {
      await sleep(1000 * attempt);
      return graphql(query, variables, attempt + 1);
    }
    if (!response.ok) throw new Error(`Shopify GraphQL HTTP ${response.status}: ${await shortBody(response)}`);

    const body = await response.json();
    if (body.errors?.some((e) => e.extensions?.code === 'THROTTLED') && attempt < 5) {
      await sleep(1000 * attempt);
      return graphql(query, variables, attempt + 1);
    }
    if (body.errors?.length) throw new Error(`Shopify GraphQL error: ${JSON.stringify(body.errors)}`);
    return body.data;
  }

  return { graphql };
}

function throwOnUserErrors(result, label) {
  const errors = result?.userErrors ?? [];
  if (errors.length) throw new Error(`${label}: ${errors.map((e) => e.message).join('; ')}`);
  return result;
}

/** The order operations the booking service needs. Tests swap this for a fake. */
export function createShopifyOrders(client) {
  return {
    async addTags(orderGid, tags) {
      const data = await client.graphql(
        `mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { field message } } }`,
        { id: orderGid, tags },
      );
      throwOnUserErrors(data.tagsAdd, 'tagsAdd');
    },

    async removeTags(orderGid, tags) {
      const data = await client.graphql(
        `mutation($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { field message } } }`,
        { id: orderGid, tags },
      );
      throwOnUserErrors(data.tagsRemove, 'tagsRemove');
    },

    /** Write tpc.* metafields on the order, e.g. { consignment_no: '5001000001', status: 'Booked' }. */
    async setMetafields(orderGid, values) {
      const metafields = Object.entries(values).map(([key, value]) => ({
        ownerId: orderGid,
        namespace: 'tpc',
        key,
        type: 'single_line_text_field',
        // Single-line fields reject newlines and cap at 255 characters.
        value: String(value).replace(/\s+/g, ' ').slice(0, 255),
      }));
      const data = await client.graphql(
        `mutation($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { userErrors { field message } } }`,
        { metafields },
      );
      throwOnUserErrors(data.metafieldsSet, 'metafieldsSet');
    },

    /** Fulfil every open fulfillment order on the order with the given tracking details. */
    async fulfil(orderGid, { number, company, url, notifyCustomer }) {
      const data = await client.graphql(
        `query($id: ID!) { order(id: $id) { fulfillmentOrders(first: 20) { nodes { id status } } } }`,
        { id: orderGid },
      );
      const open = (data.order?.fulfillmentOrders?.nodes ?? [])
        .filter((fo) => ['OPEN', 'IN_PROGRESS'].includes(fo.status));
      if (!open.length) throw new Error('No open fulfillment orders on this order (already fulfilled or on hold?).');

      // fulfillmentCreate only accepts fulfillment orders from one location at a time.
      for (const fo of open) {
        const result = await client.graphql(
          `mutation($fulfillment: FulfillmentInput!) {
             fulfillmentCreate(fulfillment: $fulfillment) { fulfillment { id status } userErrors { field message } }
           }`,
          {
            fulfillment: {
              lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: fo.id }],
              notifyCustomer,
              trackingInfo: { number, company, ...(url ? { url } : {}) },
            },
          },
        );
        throwOnUserErrors(result.fulfillmentCreate, 'fulfillmentCreate');
      }
      return open.length;
    },
  };
}
