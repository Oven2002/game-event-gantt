function registerDrag(): () => void {
  const element = document.getElementById('waifu');
  if (!element) return () => {};

  let winWidth = window.innerWidth;
  let winHeight = window.innerHeight;
  let imgWidth = element.offsetWidth;
  let imgHeight = element.offsetHeight;
  let dragging = false;
  let startClientX = 0;
  let startClientY = 0;
  let startLeft = 0;
  let startTop = 0;

  const handleMouseDown = (event: MouseEvent) => {
    if (event.button === 2 || event.target !== document.getElementById('live2d')) return;
    event.preventDefault();
    dragging = true;
    startClientX = event.clientX;
    startClientY = event.clientY;
    // #waifu carries a persistent visual transform (translateY + scale in
    // mascot.css), so getBoundingClientRect() and event.offsetX live in a
    // different coordinate space than style.left/top. Read the resolved layout
    // position instead: for positioned elements getComputedStyle returns used
    // pixel values unaffected by the transform, so the widget does not jump on
    // mousedown. This also freezes the right/bottom anchoring into left/top, so
    // a plain click (no movement) no longer falls back to the CSS default
    // position.
    const computed = getComputedStyle(element);
    startLeft = parseFloat(computed.left) || 0;
    startTop = parseFloat(computed.top) || 0;
    element.style.left = `${startLeft}px`;
    element.style.top = `${startTop}px`;
    element.style.right = 'auto';
    element.style.bottom = 'auto';
  };
  const handleMouseMove = (event: MouseEvent) => {
    if (!dragging) return;
    // Delta-based dragging: while the transform stays constant, a layout-space
    // delta moves the visual box by exactly the same amount, so the grabbed
    // point stays under the cursor regardless of scale/translate.
    let left = startLeft + (event.clientX - startClientX);
    let top = startTop + (event.clientY - startClientY);
    left = Math.max(0, Math.min(left, Math.max(0, winWidth - imgWidth)));
    top = Math.max(0, Math.min(top, Math.max(0, winHeight - imgHeight)));
    element.style.top = `${top}px`;
    element.style.left = `${left}px`;
  };
  const handleMouseUp = () => {
    dragging = false;
  };
  const handleResize = () => {
    winWidth = window.innerWidth;
    winHeight = window.innerHeight;
    imgWidth = element.offsetWidth;
    imgHeight = element.offsetHeight;
  };

  element.addEventListener('mousedown', handleMouseDown);
  document.addEventListener('mousemove', handleMouseMove);
  document.addEventListener('mouseup', handleMouseUp);
  window.addEventListener('resize', handleResize);

  return () => {
    dragging = false;
    element.removeEventListener('mousedown', handleMouseDown);
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
    window.removeEventListener('resize', handleResize);
  };
}

export default registerDrag;
