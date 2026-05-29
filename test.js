// 本地测试脚本 - 用 Node.js 运行
// 测试方式：node test.js

const TESTS = [
  { name: 'GET /health', method: 'GET', path: '/health' },
  { name: 'GET /v1/models', method: 'GET', path: '/v1/models' },
  {
    name: 'POST /v1/chat/completions',
    method: 'POST',
    path: '/v1/chat/completions',
    body: {
      model: 'deepseek-v4-flash-free',
      messages: [{ role: 'user', content: 'Say hi in one word' }],
      max_tokens: 10,
    },
  },
];

async function runTests(baseUrl) {
  console.log(`Testing against: ${baseUrl}\n`);

  for (const test of TESTS) {
    process.stdout.write(`  ${test.name}... `);
    try {
      const options = {
        method: test.method,
        headers: { 'Content-Type': 'application/json' },
      };
      if (test.body) options.body = JSON.stringify(test.body);

      const res = await fetch(`${baseUrl}${test.path}`, options);
      const data = await res.text();
      const display = data.length > 200 ? data.slice(0, 200) + '...' : data;
      console.log(`${res.status} ${res.statusText}`);
      console.log(`    Response: ${display}\n`);
    } catch (e) {
      console.log(`FAILED: ${e.message}\n`);
    }
  }
}

const baseUrl = process.argv[2] || 'http://localhost:8787';
runTests(baseUrl);
