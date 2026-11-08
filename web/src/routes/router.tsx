/**
 * The route table, and nothing else: each page module owns its loader, action
 * and component, so adding a page is one module and one entry here.
 */
import { createBrowserRouter } from "react-router";
import { get, type Bootstrap } from "../api.ts";
import { Layout } from "../ui/layout.tsx";
import { ErrorView } from "../ui/feedback.tsx";
import * as overview from "../pages/overview.tsx";
import * as users from "../pages/users.tsx";
import * as roles from "../pages/roles.tsx";
import * as memory from "../pages/memory.tsx";
import * as identity from "../pages/identity.tsx";
import * as conversations from "../pages/conversations.tsx";
import * as commands from "../pages/commands.tsx";
import * as spend from "../pages/spend.tsx";
import { ConsolePage } from "../pages/console.tsx";
import { ArchitecturePage } from "../pages/architecture.tsx";

export const router = createBrowserRouter([
  {
    id: "root",
    path: "/",
    loader: async () => get<Bootstrap>("bootstrap"),
    element: <Layout />,
    errorElement: (
      <div className="app">
        <main>
          <ErrorView />
        </main>
      </div>
    ),
    children: [
      { index: true, loader: overview.loader, element: <overview.OverviewPage /> },
      { path: "users", loader: users.loader, action: users.action, element: <users.UsersPage /> },
      { path: "roles", loader: roles.loader, action: roles.action, element: <roles.RolesPage /> },
      { path: "learnings", loader: memory.loader, action: memory.action, element: <memory.LearningsPage /> },
      { path: "identity", loader: identity.loader, action: identity.action, element: <identity.IdentityPage /> },
      {
        path: "conversations",
        loader: conversations.listLoader,
        action: conversations.clearAction,
        element: <conversations.ConversationsPage />,
      },
      {
        path: "conversations/:channel",
        loader: conversations.channelLoader,
        action: conversations.clearAction,
        element: <conversations.ConversationPage />,
      },
      { path: "console", element: <ConsolePage /> },
      { path: "commands", loader: commands.loader, action: commands.action, element: <commands.CommandsPage /> },
      { path: "spend", loader: spend.loader, element: <spend.SpendPage /> },
      { path: "architecture", element: <ArchitecturePage /> },
    ],
  },
]);
