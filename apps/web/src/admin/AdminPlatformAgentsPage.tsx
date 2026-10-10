import { useEffect, useState } from "react";
import {
  ApiClientError,
  apiClient,
  type AdminPlatformAgent,
  type AdminUserAgent,
} from "../api.js";
import {
  Alert,
  Badge,
  DataTable,
  EmptyState,
  PageHeader,
  Spinner,
  type BadgeTone,
} from "../ui/index.js";

function platformAgentStatusTone(
  status: AdminPlatformAgent["status"],
): BadgeTone {
  if (status === "active") return "success";
  if (status === "failed") return "danger";
  if (status === "provisioning" || status === "deleting") return "warning";
  return "neutral";
}

function userAgentStatusTone(status: AdminUserAgent["status"]): BadgeTone {
  if (status === "active") return "success";
  if (status === "failed") return "danger";
  if (status === "provisioning" || status === "deleting") return "warning";
  return "neutral";
}

function UserAgentsPanel({ onAuthRequired }: { onAuthRequired: () => void }) {
  const [agents, setAgents] = useState<AdminUserAgent[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    apiClient
      .listAdminUserAgents()
      .then((result) => {
        if (active) setAgents(result.agents);
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof ApiClientError && error.isAuthRequired) {
          onAuthRequired();
        } else {
          setFailed(true);
        }
      });
    return () => {
      active = false;
    };
  }, [onAuthRequired]);

  if (failed) {
    return <Alert tone="danger">User Agents could not be loaded.</Alert>;
  }
  if (agents === null) {
    return (
      <div className="skills-loading" aria-busy="true">
        <Spinner label="Loading user Agents" />
      </div>
    );
  }
  if (agents.length === 0) {
    return <EmptyState title="No user Agents exist yet." />;
  }
  return (
    <DataTable
      caption="User Agents"
      className="admin-agent-table"
      minWidth="wide"
    >
      <thead>
        <tr>
          <th scope="col">Agent</th>
          <th scope="col">Owner</th>
          <th scope="col">Type</th>
          <th scope="col">Skills</th>
          <th scope="col">Status</th>
        </tr>
      </thead>
      <tbody>
        {agents.map((agent) => (
          <tr key={agent.id}>
            <th scope="row" data-label="Agent">
              <div className="admin-agent-summary">
                <strong>{agent.name}</strong>
                <span>{agent.description || "No description"}</span>
                <span>{agent.modelId}</span>
              </div>
            </th>
            <td data-label="Owner">{agent.ownerEmail}</td>
            <td data-label="Type">
              {agent.isAutoDefault ? (
                <Badge tone="info">Default for user</Badge>
              ) : (
                <Badge tone="neutral">Personal</Badge>
              )}
            </td>
            <td data-label="Skills">
              {agent.skills.length === 0 ? (
                <span className="admin-agent-model">—</span>
              ) : (
                <div className="admin-status-stack">
                  {agent.skills.map((skill) => (
                    <Badge key={skill.id} tone="neutral">
                      {skill.displayTitle}
                    </Badge>
                  ))}
                </div>
              )}
            </td>
            <td data-label="Status">
              <Badge tone={userAgentStatusTone(agent.status)}>
                {agent.status}
              </Badge>
            </td>
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}

export function AdminPlatformAgentsPage({
  agents,
  onAuthRequired,
}: {
  agents: AdminPlatformAgent[];
  onAuthRequired: () => void;
}) {
  const [tab, setTab] = useState<"system" | "user">("system");

  return (
    <div className="page admin-page">
      <PageHeader
        title="Agents"
        description={
          tab === "system"
            ? "System Agents are configured through SYSTEM_AGENT_IDS in .env. Restart the API after changing the configuration."
            : "View user Agents and their current status."
        }
      />

      <div
        className="skills-tabs admin-agent-tabs"
        role="tablist"
        aria-label="Agent scope"
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === "system"}
          className={tab === "system" ? "is-active" : undefined}
          onClick={() => setTab("system")}
        >
          System Agents
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "user"}
          className={tab === "user" ? "is-active" : undefined}
          onClick={() => setTab("user")}
        >
          User Agents
        </button>
      </div>

      {tab === "user" ? (
        <UserAgentsPanel onAuthRequired={onAuthRequired} />
      ) : agents.length === 0 ? (
        <EmptyState title="No System Agents configured." />
      ) : (
        <DataTable
          caption="Platform Agents"
          className="admin-agent-table"
          minWidth="wide"
        >
          <thead>
            <tr>
              <th scope="col">Agent</th>
              <th scope="col">Model</th>
              <th scope="col">Current Ark version</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((agent) => (
              <tr key={agent.id}>
                <th scope="row" data-label="Agent">
                  <div className="admin-agent-summary">
                    <strong>{agent.name}</strong>
                    <span>{agent.description || "No description"}</span>
                  </div>
                </th>
                <td className="admin-agent-model" data-label="Model">
                  <span>{agent.modelId}</span>
                </td>
                <td data-label="Current Ark version">
                  <span>{agent.arkVersion}</span>
                </td>
                <td data-label="Status">
                  <div className="admin-status-stack">
                    <Badge tone={platformAgentStatusTone(agent.status)}>
                      {agent.status}
                    </Badge>
                    {agent.lastErrorCode ? (
                      <Badge tone="danger">Sync needs attention</Badge>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </div>
  );
}
