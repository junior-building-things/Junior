export default function Home() {
  return (
    <div style={{ fontFamily: 'system-ui', padding: '2rem', maxWidth: 600, margin: '0 auto' }}>
      <h1>Junior Bot 🤖</h1>
      <p>AI-powered Lark assistant. Webhook endpoint: <code>/api/webhook</code></p>
      <h3>Capabilities</h3>
      <ul>
        <li>Natural conversation in Lark groups</li>
        <li>Meego: list features, check status, create stories, complete nodes</li>
        <li>Lark Docs: read, edit sections, add sections, create PRDs</li>
        <li>Finance: stock prices and market data</li>
      </ul>
    </div>
  );
}
