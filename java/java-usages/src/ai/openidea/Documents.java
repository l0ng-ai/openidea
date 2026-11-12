package ai.openidea;

import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.core.runtime.OperationCanceledException;
import org.eclipse.jdt.ls.core.internal.JobHelpers;
import org.eclipse.jdt.ls.core.internal.handlers.BaseDocumentLifeCycleHandler;

/** What a command that reads an editor's position needs before it resolves the position. */
public final class Documents {
    private Documents() {}

    /**
     * Waits for the queued document changes to be reconciled, as JDT LS's own position requests
     * do: `workspace/executeCommand` does not, so a position sent right after an edit would
     * be resolved against the element structure from before it.
     */
    public static void awaitChanges(IProgressMonitor monitor) {
        JobHelpers.waitForJobs(BaseDocumentLifeCycleHandler.DOCUMENT_LIFE_CYCLE_JOBS, monitor);
        if (monitor.isCanceled()) throw new OperationCanceledException();
    }
}
