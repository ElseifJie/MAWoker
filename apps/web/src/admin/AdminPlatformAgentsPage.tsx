import { Pencil, Plus, Power, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ApiClientError,
  apiClient,
  type AdminPlatformAgent,
  type AdminUserAgent,
} from "../api.js";
import {
  Alert,
  Badge,
  Button,
  DataTable,
  Dialog,
  EmptyState,
  PageHeader,
  RowActionsMenu,
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
    <DataTable caption="User Agents" className="admin-agent-table" minWidth="wide">
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
  onAgentsChanged,
  onAuthRequired,
}: {
  agents: AdminPlatformAgent[];
  onAgentsChanged: (agents: AdminPlatformAgent[]) => void;
  onAuthRequired: () => void;
}) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<"system" | "user">("system");
  const [deleteTarget, setDeleteTarget] = useState<AdminPlatformAgent | null>(
    null,
  );
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  function closeDeleteDialog() {
    setDeleteTarget(null);
    setFeedback(null);
  }

  function handleError(error: unknown, operation: "save" | "delete") {
    if (error instanceof ApiClientError && error.isAuthRequired) {
      onAuthRequired();
      return;
    }
    if (
      operation === "delete" &&
      error instanceof ApiClientError &&
      error.status === 409
    ) {
      setFeedback(
        "This Agent is still assigned to users or referenced by Sessions.",
      );
      return;
    }
    if (operation === "delete") {
      setFeedback("The Agent could not be deleted.");
      setDeleteTarget(null);
    }
  }

  async function toggleStatus(agent: AdminPlatformAgent) {
    if (pending || (agent.status !== "active" && agent.status !== "disabled")) {
      return;
    }
    setPending(true);
    setFeedback(null);
    try {
      const updated = await apiClient.updateAdminPlatformAgent(agent.id, {
        status: agent.status === "active" ? "disabled" : "active",
      });
      onAgentsChanged(
        agents.map((candidate) =>
          candidate.id === updated.id ? updated : candidate,
        ),
      );
    } catch (error) {
      if (error instanceof ApiClientError && error.isAuthRequired) {
        onAuthRequired();
      } else if (error instanceof ApiClientError && error.retryable) {
        setFeedback("Ark is temporarily unavailable. Try again.");
      } else {
        setFeedback("The Agent status could not be changed.");
      }
    } finally {
      setPending(false);
    }
  }

  async function deleteAgent() {
    if (!deleteTarget || pending) return;
    setPending(true);
    setFeedback(null);
    try {
      await apiClient.deleteAdminPlatformAgent(deleteTarget.id);
      onAgentsChanged(agents.filter((agent) => agent.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (error) {
      handleError(error, "delete");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="page admin-page">
      <PageHeader
        title="Agents"
        headingRef={headingRef}
        actions={
          tab === "system" ? (
            <Button onClick={() => navigate("/admin/platform-agents/new")}>
              <Plus size={16} aria-hidden="true" />
              New platform Agent
            </Button>
          ) : undefined
        }
      />

      <div className="skills-tabs admin-agent-tabs" role="tablist" aria-label="Agent scope">
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

      {feedback && !deleteTarget ? (
        <Alert className="admin-page-feedback" tone="danger">
          {feedback}
        </Alert>
      ) : null}

      {tab === "user" ? (
        <UserAgentsPanel onAuthRequired={onAuthRequired} />
      ) : (
        <>
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
                <th scope="col">Actions</th>
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
                  <td data-label="Actions">
                    <div className="admin-row-actions">
                      <Button
                        size="compact"
                        variant="secondary"
                        aria-label={`Edit ${agent.name}`}
                        onClick={() =>
                          navigate(`/admin/platform-agents/${agent.id}/edit`)
                        }
                        disabled={pending || agent.status === "deleting"}
                      >
                        <Pencil size={14} aria-hidden="true" />
                        Edit
                      </Button>
                      <RowActionsMenu
                        label={`Actions for ${agent.name}`}
                        items={[
                          ...(agent.status === "active" ||
                          agent.status === "disabled"
                            ? [
                                {
                                  icon: <Power size={14} aria-hidden="true" />,
                                  text:
                                    agent.status === "active"
                                      ? "Disable"
                                      : "Enable",
                                  run: () => void toggleStatus(agent),
                                },
                              ]
                            : []),
                          {
                            icon: <Trash2 size={14} aria-hidden="true" />,
                            text: "Delete",
                            danger: true,
                            disabled: pending || agent.status === "deleting",
                            run: () => {
                              setFeedback(null);
                              setDeleteTarget(agent);
                            },
                          },
                        ]}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>

          <Dialog
            open={deleteTarget !== null}
            title="Delete platform Agent?"
            onClose={closeDeleteDialog}
            closeLabel="Close platform Agent deletion"
            closeDisabled={pending}
            fallbackFocusRef={headingRef}
            footer={
              deleteTarget ? (
                <>
                  <Button
                    data-dialog-initial-focus
                    variant="secondary"
                    onClick={closeDeleteDialog}
                    disabled={pending}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => void deleteAgent()}
                    loading={pending}
                  >
                    Delete Agent
                  </Button>
                </>
              ) : null
            }
          >
            {deleteTarget ? (
              <>
                <p className="admin-dialog-copy">
                  Delete <strong>{deleteTarget.name}</strong>. The server will
                  reject this action while users or Sessions still reference it.
                </p>
                {feedback ? (
                  <Alert className="admin-dialog-feedback" tone="danger">
                    {feedback}
                  </Alert>
                ) : null}
              </>
            ) : null}
          </Dialog>
        </>
      )}
    </div>
  );
}
