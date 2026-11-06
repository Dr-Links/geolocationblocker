"use client";

import { NativeSelect } from "@/components/ui/select";
import { switchWorkspaceAction } from "@/app/workspace-actions";

export function WorkspaceSwitcher({ workspaces, activeId }: { workspaces: { id: string; name: string }[]; activeId: string }) {
  return (
    <form action={switchWorkspaceAction}>
      <label htmlFor="workspace-switcher" className="sr-only">Workspace</label>
      <NativeSelect
        id="workspace-switcher"
        name="workspaceId"
        defaultValue={activeId}
        data-testid="workspace-switcher"
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
      >
        {workspaces.map((w) => (
          <option key={w.id} value={w.id}>{w.name}</option>
        ))}
      </NativeSelect>
      <noscript><button type="submit">Switch</button></noscript>
    </form>
  );
}
