import { Dialog } from "@/ui";
import { Sidebar } from "./components/Sidebar";
import { executeCreateProject } from "./createProject";
import { EmptyProjectView } from "./generators/EmptyProjectView";
import { JavaProjectView } from "./generators/JavaProjectView";
import { SpringBootView } from "./generators/SpringBootView";
import { ViteProjectView } from "./generators/ViteProjectView";
import { useNewProjectStore } from "./store";
import styles from "./NewProjectDialog.module.css";

export function NewProjectDialog() {
  const isOpen = useNewProjectStore((s) => s.isOpen);
  const activeId = useNewProjectStore((s) => s.activeId);
  const searchQuery = useNewProjectStore((s) => s.searchQuery);
  const isCreating = useNewProjectStore((s) => s.isCreating);
  const createError = useNewProjectStore((s) => s.createError);

  const closeDialog = useNewProjectStore((s) => s.closeDialog);
  const setActiveId = useNewProjectStore((s) => s.setActiveId);
  const setSearchQuery = useNewProjectStore((s) => s.setSearchQuery);
  const setIsCreating = useNewProjectStore((s) => s.setIsCreating);
  const setCreateError = useNewProjectStore((s) => s.setCreateError);

  const state = useNewProjectStore.getState();

  if (!isOpen) return null;

  const handleCreate = async () => {
    setIsCreating(true);
    setCreateError(null);
    try {
      await executeCreateProject(activeId, {
        springBoot: state.springBoot,
        java: state.java,
        empty: state.empty,
        vite: state.vite,
      });
      closeDialog();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsCreating(false);
    }
  };

  const renderContent = () => {
    switch (activeId) {
      case "spring-boot":
        return <SpringBootView />;
      case "java":
        return <JavaProjectView language="Java" />;
      case "kotlin":
        return <JavaProjectView language="Kotlin" />;
      case "empty":
        return <EmptyProjectView />;
      case "vite":
        return <ViteProjectView />;
      default:
        return <SpringBootView />;
    }
  };

  return (
    <Dialog
      open={isOpen}
      onClose={closeDialog}
      title="New Project"
      width={840}
      resizable="both"
      onHelp={() => {
        window.open("https://www.jetbrains.com/help/idea/creating-and-managing-projects.html", "_blank");
      }}
      buttons={[
        {
          label: isCreating ? "Creating…" : "Create",
          role: "default",
          disabled: isCreating,
          onClick: () => void handleCreate(),
        },
        {
          label: "Cancel",
          role: "cancel",
          disabled: isCreating,
        },
      ]}
    >
      {createError && <div className={styles.errorBanner}>{createError}</div>}
      <div className={styles.container}>
        <Sidebar activeId={activeId} searchQuery={searchQuery} onSelect={setActiveId} onSearchChange={setSearchQuery} />
        <div className={styles.main}>{renderContent()}</div>
      </div>
    </Dialog>
  );
}
