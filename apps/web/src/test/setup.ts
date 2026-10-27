// Vuetify expects ResizeObserver and visualViewport; jsdom has neither. Node environments skip this.
if (typeof window !== 'undefined') {
  if (!('ResizeObserver' in window)) {
    Object.defineProperty(window, 'ResizeObserver', {
      value: class {
        observe () {}
        unobserve () {}
        disconnect () {}
      },
    })
  }
  if (!('visualViewport' in window)) {
    Object.defineProperty(window, 'visualViewport', {
      value: { addEventListener () {}, removeEventListener () {}, width: 1024, height: 768, offsetTop: 0, offsetLeft: 0, scale: 1 },
    })
  }
}
