import pg from "pg";

const { Pool } = pg;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl });

function quotaSetting(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    console.error(
      `${name} must be a non-negative integer, got ${JSON.stringify(raw)}`,
    );
    process.exit(1);
  }
  return value;
}

const defaultQuota = {
  personalAgentLimit: quotaSetting("PERSONAL_AGENT_LIMIT", 10),
  concurrentSessionLimit: quotaSetting("CONCURRENT_SESSION_LIMIT", 2),
  dailySessionLimit: quotaSetting("SESSION_DAILY_LIMIT", 25),
  monthlyTokenLimit: quotaSetting("MONTHLY_TOKEN_LIMIT", 1000000),
};

try {
  // 1. 查看现有用户
  const usersResult = await pool.query(
    "SELECT id, email, role, status FROM users;",
  );
  console.log("现有用户:", JSON.stringify(usersResult.rows, null, 2));

  // 2. 插入默认配额策略
  await pool.query(
    `INSERT INTO quota_policies (key, personal_agent_limit, concurrent_session_limit, daily_session_limit, monthly_token_limit)
     VALUES ('default', $1, $2, $3, $4)
     ON CONFLICT (key) DO NOTHING;`,
    [
      defaultQuota.personalAgentLimit,
      defaultQuota.concurrentSessionLimit,
      defaultQuota.dailySessionLimit,
      defaultQuota.monthlyTokenLimit,
    ],
  );
  console.log(
    `✓ 默认配额策略已插入 (agent ${defaultQuota.personalAgentLimit}, 并发 ${defaultQuota.concurrentSessionLimit}, 每日 Session ${defaultQuota.dailySessionLimit}, 月度 Token ${defaultQuota.monthlyTokenLimit})`,
  );

  if (usersResult.rows.length > 0) {
    const firstUser = usersResult.rows[0];

    // 3. 把第一个用户设为 admin
    await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [
      firstUser.id,
    ]);
    console.log(`✓ 用户 ${firstUser.email} 已设为管理员`);

    // 4. 插入平台 Agent
    const agentResult = await pool.query(
      `
      INSERT INTO platform_agents (id, ark_agent_id, name, description, model_id, system_prompt, ark_version, status, created_by, updated_by)
      VALUES (
        gen_random_uuid(),
        'agent-20260907130629-wssnn',
        '默认助手',
        '平台默认 Agent',
        'deepseek-v4-pro-ga-260813',
        '你是一个有帮助的 AI 助手。',
        '1',
        'active',
        $1,
        $1
      )
      ON CONFLICT (ark_agent_id) DO NOTHING
      RETURNING id, name;
    `,
      [firstUser.id],
    );

    let platformAgentId;
    if (agentResult.rows.length > 0) {
      platformAgentId = agentResult.rows[0].id;
      console.log(
        `✓ 平台 Agent 已创建: ${agentResult.rows[0].name} (${platformAgentId})`,
      );
    } else {
      const existing = await pool.query(
        "SELECT id, name FROM platform_agents WHERE ark_agent_id = 'agent-20260907130629-wssnn'",
      );
      platformAgentId = existing.rows[0].id;
      console.log(
        `✓ 平台 Agent 已存在: ${existing.rows[0].name} (${platformAgentId})`,
      );
    }

    // 5. 为所有用户分配默认 Agent
    await pool.query(
      `
      INSERT INTO user_default_agents (user_id, platform_agent_id, assigned_by)
      SELECT u.id, $1, $2
      FROM users u
      ON CONFLICT (user_id) DO NOTHING;
    `,
      [platformAgentId, firstUser.id],
    );
    console.log("✓ 默认 Agent 已分配给所有用户");
  } else {
    console.log("⚠️  暂无用户，请先登录注册一个用户后再运行此脚本");
  }

  console.log("\n✅ 初始化完成");
} catch (err) {
  console.error("❌ 错误:", err.message);
  process.exit(1);
} finally {
  await pool.end();
}
