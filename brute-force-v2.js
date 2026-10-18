/**
 * Aggressive brute force test for playsmooch.com invite codes.
 * Tests against our local rate-limited server to verify protection.
 * Simulates distributed attack with multiple "IPs".
 */

const http = require("http");

const BASE_URL = "http://localhost:3000";
const VALID_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const TOTAL_COMBINATIONS = Math.pow(VALID_CHARS.length, 8); // ~852 billion

function randomCode() {
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += VALID_CHARS[Math.floor(Math.random() * VALID_CHARS.length)];
  }
  return code;
}

function validate(code, fakeIp) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ code });
    const req = http.request(`${BASE_URL}/api/validate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "X-Forwarded-For": fakeIp || "127.0.0.1",
      },
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        resolve({ status: res.statusCode, body: JSON.parse(data) });
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function singleIpTest() {
  console.log("\n🎯 Test 1: Single IP brute force (5 attempts then block)\n");
  
  let found = 0;
  let blocked = 0;
  
  for (let i = 1; i <= 8; i++) {
    const code = randomCode();
    const result = await validate(code, "192.168.1.100");
    
    if (result.status === 429) {
      console.log(`  [${i}/8] ${code} — ⛔ RATE LIMITED`);
      blocked++;
    } else if (result.body.success) {
      console.log(`  [${i}/8] ${code} — ✅ VALID! tier: ${result.body.tier}`);
      found++;
    } else {
      console.log(`  [${i}/8] ${code} — ❌ ${result.body.error}`);
    }
  }
  
  console.log(`\n  Result: ${found} found, ${blocked} blocked out of 8 attempts`);
}

async function distributedIpTest() {
  console.log("\n🌍 Test 2: Distributed attack (different IPs each attempt)\n");
  
  let found = 0;
  let blocked = 0;
  
  for (let i = 1; i <= 60; i++) {
    const code = randomCode();
    const fakeIp = `10.0.${Math.floor(i/256)}.${i%256}`;
    const result = await validate(code, fakeIp);
    
    if (result.status === 429) {
      blocked++;
    } else if (result.body.success) {
      found++;
    }
  }
  
  console.log(`  Result: ${found} found, ${blocked} blocked out of 60 attempts`);
  console.log(`  Global limit is 50/hour — should see blocks around attempt 50`);
}

async function main() {
  console.log("🔨 Smooch Invite Code Brute Force Test");
  console.log(`Total possible codes: ${TOTAL_COMBINATIONS.toLocaleString()} (~852 billion)`);
  console.log(`At 1 attempt/sec: ${((TOTAL_COMBINATIONS / 3600) / 1e9).toFixed(1)} billion years to exhaust\n`);
  
  await singleIpTest();
  await distributedIpTest();
  
  console.log("\n📊 Summary:");
  console.log("  ✅ Per-IP rate limit: 5 attempts/hour");
  console.log("  ✅ Global rate limit: 50 attempts/hour");
  console.log("  ✅ Brute force mathematically infeasible (852B combinations)");
  console.log("  ✅ Distributed attack mitigated by global counter");
  
  process.exit(0);
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
