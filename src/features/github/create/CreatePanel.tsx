/**
 * PLACEHOLDER (foundation stub) — the "New Pull Request at {repo}" tab. Wave 1 "create"
 * replaces it.
 *
 * Contract: `CreatePanel()` takes no props and renders inside the New Pull Request tab
 * while the tool window is connected. Create with `createPullRequest` (`data/operations.ts`,
 * GraphQL `createPullRequest` + reviewers / assignees / labels), pickers from
 * `useRepositoryList` / `usePotentialReviewers` (`data/repository.ts`), the template from
 * `loadPullRequestTemplate()`; existing pull requests for the head with
 * `findOpenPullRequestsByHead` (`api/requests.ts`). On success open the new pull request
 * (`openPullRequest`) and close the tab (`closeTab("create")`).
 *
 * Until then it offers the quick gh dialog.
 */
import { Button, T } from "@/ui";
import { createPullRequestWithDialog } from "../toolwindow/quickCreate";
import { closeTab } from "../toolwindow/store";
import { Placeholder } from "../ui/Placeholder";

export function CreatePanel() {
  return (
    <Placeholder title="New pull request form (placeholder)">
      <Button
        size="small"
        variant="primary"
        onClick={async () => {
          if (await createPullRequestWithDialog()) closeTab("create");
        }}
      >
        <T>Create Pull Request…</T>
      </Button>
    </Placeholder>
  );
}
