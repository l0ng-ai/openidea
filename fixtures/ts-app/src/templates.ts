// Embedded languages in template literals: CSS, GraphQL, SQL and HTML are highlighted inside them.
// The tags are local stand-ins for styled-components, graphql-tag, a SQL client and Lit.

type Tag = (strings: TemplateStringsArray, ...values: unknown[]) => string;

const tag: Tag = (strings, ...values) => String.raw({ raw: strings }, ...values);
const css = tag;
const keyframes = tag;
const gql = tag;
const sql = tag;
const html = tag;
const styled = Object.assign((_component: unknown) => tag, { button: tag, div: tag });

export const fadeIn = keyframes`
  from { opacity: 0; }
  to { opacity: 1; }
`;

export const Button = styled.button`
  padding: 4px 12px;
  color: ${() => "white"};
  background: #3574f0;
  animation: ${fadeIn} 120ms ease-out;

  &:hover {
    background: #4682fa;
  }
`;

export const Card = styled(Button)`
  border-radius: 8px;
`;

export const centered = css`
  display: flex;
  align-items: center;
`;

export const CART_QUERY = gql`
  query Cart($id: ID!, $first: Int = 10) {
    cart(id: $id) {
      total
      items(first: $first) {
        ...CartItem
      }
    }
  }

  fragment CartItem on Item {
    name
    price
  }
`;

export function cartRows(cartId: string): string {
  return sql`
    SELECT name, price
    FROM cart_items
    WHERE cart_id = ${cartId}
    ORDER BY price DESC
  `;
}

export function cartView(total: string): string {
  return html`<section class="cart"><h2>Total</h2><p>${total}</p></section>`;
}

export const ITEM_FIELDS = /* GraphQL */ `
  fragment ItemFields on Item { name price }
`;
