package ai.openidea.jvminspect;

import com.sun.jdi.VirtualMachine;
import com.sun.jdi.event.Event;
import com.sun.jdi.event.EventSet;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.Collection;
import java.util.Optional;
import java.util.function.Consumer;
import java.util.function.Function;
import org.eclipse.core.resources.ResourcesPlugin;

/**
 * java-debug's debug session of a VM, reached through the hot code replace provider that each session
 * registers as a workspace resource listener. Nothing here is API: every step that no longer resolves
 * is {@link ConnectedVms.Unsupported}, never a crash.
 */
final class JavaDebugSessions {
    static final String HCR_PROVIDER = "com.microsoft.java.debug.plugin.internal.JavaHotCodeReplaceProvider";
    static final String SESSION = "com.microsoft.java.debug.core.IDebugSession";
    static final String EVENT_HUB = "com.microsoft.java.debug.core.IEventHub";
    static final String OBSERVABLE = "io.reactivex.Observable";
    static final String CONSUMER = "io.reactivex.functions.Consumer";
    static final String DISPOSABLE = "io.reactivex.disposables.Disposable";

    interface Listener {
        void onEvent(HubEvent event) throws Exception;
    }

    interface Subscription extends AutoCloseable {
        @Override
        void close();
    }

    private JavaDebugSessions() {}

    /**
     * Empty when no session of {@code vm} is registered: java-debug registers the provider only when
     * its {@code hotCodeReplace} setting is not {@code never}.
     */
    static Optional<Hub> of(VirtualMachine vm) throws ConnectedVms.Unsupported {
        Object workspace;
        try {
            workspace = ResourcesPlugin.getWorkspace();
        } catch (RuntimeException e) {
            throw new ConnectedVms.Unsupported(e.toString());
        }
        return find(workspace, vm, InspectCommand::loadJavaDebug);
    }

    /**
     * {@code Workspace.notificationManager.listeners.listeners[].listener}, the providers among them,
     * then the one whose {@code currentDebugSession.getVM()} is {@code vm}.
     *
     * @param loader loads a class of the java-debug bundle by name; {@code null} when it is not there
     */
    static Optional<Hub> find(Object workspace, Object vm, Function<String, Class<?>> loader) throws ConnectedVms.Unsupported {
        Class<?> provider = load(loader, HCR_PROVIDER);
        Class<?> session = load(loader, SESSION);
        try {
            Object notifications = get(workspace, "notificationManager");
            Object list = get(get(notifications, "listeners"), "listeners");
            Object[] entries = list instanceof Collection<?> c ? c.toArray() : (Object[]) list;
            Method getVm = session.getMethod("getVM");
            for (Object entry : entries) {
                Object listener = get(entry, "listener");
                if (!provider.isInstance(listener)) continue;
                Object s = get(listener, "currentDebugSession");
                if (s != null && getVm.invoke(s) == vm) {
                    Object hub = session.getMethod("getEventHub").invoke(s);
                    return Optional.of(new Hub(load(loader, EVENT_HUB).getMethod("events").invoke(hub), loader));
                }
            }
            return Optional.empty();
        } catch (ReflectiveOperationException | RuntimeException e) {
            throw new ConnectedVms.Unsupported(e.toString());
        }
    }

    /** The events java-debug reads from the VM's event queue, before it acts on them. */
    static final class Hub {
        private final Object events;
        private final Function<String, Class<?>> loader;
        private volatile Field event;
        private volatile Field eventSet;
        private volatile Field shouldResume;

        private Hub(Object events, Function<String, Class<?>> loader) {
            this.events = events;
            this.loader = loader;
        }

        /**
         * Runs {@code listener} on java-debug's event thread for every event. Whatever the listener
         * throws goes to {@code failed} instead: RxJava drops a subscriber whose callback throws. Hub
         * errors go to {@code failed} too.
         */
        Subscription subscribe(Listener listener, Consumer<Throwable> failed) throws ConnectedVms.Unsupported {
            Class<?> consumer = load(loader, CONSUMER);
            Object onNext = consumer(consumer, value -> listener.onEvent(new HubEvent(this, value)), failed);
            Object onError = consumer(consumer, value -> failed.accept((Throwable) value), failed);
            try {
                // Everything is looked up before subscribing: a lookup failing after it would leave a live subscription.
                Method dispose = load(loader, DISPOSABLE).getMethod("dispose");
                Method subscribe = load(loader, OBSERVABLE).getMethod("subscribe", consumer, consumer);
                Object disposable = subscribe.invoke(events, onNext, onError);
                return () -> {
                    try {
                        dispose.invoke(disposable);
                    } catch (ReflectiveOperationException | RuntimeException e) {
                        failed.accept(e);
                    }
                };
            } catch (InvocationTargetException e) {
                throw new ConnectedVms.Unsupported(e.getCause().toString());
            } catch (ReflectiveOperationException | RuntimeException e) {
                throw new ConnectedVms.Unsupported(e.toString());
            }
        }

        private interface Body {
            void accept(Object value) throws Exception;
        }

        private static Object consumer(Class<?> type, Body body, Consumer<Throwable> failed) {
            return Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[] {type}, (proxy, method, args) -> switch (method.getName()) {
                case "accept" -> {
                    try {
                        body.accept(args[0]);
                    } catch (Throwable t) {
                        try {
                            failed.accept(t);
                        } catch (Throwable ignored) {
                            // nothing may reach RxJava
                        }
                    }
                    yield null;
                }
                case "hashCode" -> System.identityHashCode(proxy);
                case "equals" -> proxy == args[0];
                default -> "openidea stream trace listener";
            });
        }

        /** {@code DebugEvent}'s fields, looked up on the first event. */
        private void resolve(Object debugEvent) throws NoSuchFieldException {
            if (shouldResume != null) return;
            Class<?> type = debugEvent.getClass();
            event = ConnectedVms.field(type, "event");
            eventSet = ConnectedVms.field(type, "eventSet");
            shouldResume = ConnectedVms.field(type, "shouldResume");
        }
    }

    /** One {@code com.microsoft.java.debug.core.DebugEvent}. */
    static final class HubEvent {
        private final Hub hub;
        private final Object raw;

        private HubEvent(Hub hub, Object raw) throws NoSuchFieldException {
            this.hub = hub;
            this.raw = raw;
            hub.resolve(raw);
        }

        Event event() throws IllegalAccessException {
            return (Event) hub.event.get(raw);
        }

        EventSet eventSet() throws IllegalAccessException {
            return (EventSet) hub.eventSet.get(raw);
        }

        /**
         * Keeps java-debug from resuming the event set after its handlers ran, as its own conditional
         * breakpoints do. The thread stays suspended until someone calls {@code eventSet().resume()}.
         * Only on java-debug's event thread, inside the listener.
         */
        void park() throws IllegalAccessException {
            hub.shouldResume.setBoolean(raw, false);
        }
    }

    private static Class<?> load(Function<String, Class<?>> loader, String name) throws ConnectedVms.Unsupported {
        Class<?> type = loader.apply(name);
        if (type == null) throw new ConnectedVms.Unsupported(name + " not found");
        return type;
    }

    private static Object get(Object object, String field) throws NoSuchFieldException, IllegalAccessException {
        return ConnectedVms.field(object.getClass(), field).get(object);
    }
}
