// Runs at document start in the unprivileged picker. Only a physical click can fill the slot.
// The workbench reads this view's main-frame slot only while armed. No page-to-IDE IPC.
(() => {
  if (window !== window.top) return;
  let picked = null;
  let armed = false;
  let suppressClick = false;
  const styleOf = window.getComputedStyle.bind(window);
  const encode = JSON.stringify;
  const slice = Function.call.bind(String.prototype.slice);
  Object.defineProperty(window, "__openideaPickedElement", {
    get: () => (picked === null ? null : slice(picked, 0, 8193)),
  });
  let outline;
  function stop() {
    armed = false;
    outline?.remove();
    outline = undefined;
  }
  Object.defineProperty(window, "__openideaInspect", {
    value: (enable) => {
      stop();
      picked = null;
      suppressClick = false;
      armed = enable === true;
    },
  });
  window.addEventListener("pagehide", () => {
    stop();
    picked = null;
    suppressClick = false;
  });
  window.addEventListener(
    "pointermove",
    (event) => {
      if (!armed || !event.isTrusted || !(event.target instanceof Element) || !document.body) return;
      if (!outline) {
        outline = document.createElement("div");
        outline.setAttribute("aria-hidden", "true");
        outline.style.cssText =
          "all:initial;position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;border:2px solid #4d90fe";
        document.body.appendChild(outline);
      }
      const rect = event.target.getBoundingClientRect();
      Object.assign(outline.style, {
        left: rect.left + "px",
        top: rect.top + "px",
        width: rect.width + "px",
        height: rect.height + "px",
      });
    },
    true,
  );
  window.addEventListener(
    "pointerdown",
    (event) => {
      // Some disabled controls never emit the click after pointerdown.
      if (event.isTrusted) suppressClick = false;
      if (
        !armed ||
        !event.isTrusted ||
        !event.isPrimary ||
        event.button !== 0 ||
        !(event.target instanceof Element) ||
        picked !== null
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const element = event.target;
      const path = [];
      for (let node = element; node && path.length < 8; node = node.parentElement) {
        const tag = node.localName;
        let index = 1;
        for (
          let sibling = node.previousElementSibling;
          sibling && index < 65536;
          sibling = sibling.previousElementSibling
        )
          if (sibling.localName === tag) index++;
        if (index > 65535) return;
        path.unshift({ tag, index });
      }
      const css = styleOf(element);
      picked = encode({
        path,
        disabled: element.hasAttribute("disabled"),
        hidden: element.hasAttribute("hidden"),
        ariaDisabled: element.getAttribute("aria-disabled") === "true",
        display: css.display,
        position: css.position,
        visibility: css.visibility,
        pointerEvents: css.pointerEvents,
      });
      stop();
      suppressClick = true;
    },
    true,
  );
  // Suppress the click that follows the inspection gesture (links, form submits, app buttons).
  window.addEventListener(
    "click",
    (event) => {
      if (suppressClick) {
        suppressClick = false;
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );
  window.addEventListener(
    "keydown",
    (event) => {
      if (armed && event.isTrusted && event.key === "Escape") {
        event.preventDefault();
        stop();
        picked = "cancel";
      }
    },
    true,
  );
})();
