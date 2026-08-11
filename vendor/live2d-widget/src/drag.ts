function registerDrag(): () => void {
  const element = document.getElementById('waifu');
  if (!element) return () => {};

  let winWidth = window.innerWidth;
  let winHeight = window.innerHeight;
  let imgWidth = element.offsetWidth;
  let imgHeight = element.offsetHeight;
  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;

  const handleMouseDown = (event: MouseEvent) => {
    if (event.button === 2 || event.target !== document.getElementById('live2d')) return;
    event.preventDefault();
    dragging = true;
    offsetX = event.offsetX;
    offsetY = event.offsetY;
  };
  const handleMouseMove = (event: MouseEvent) => {
    if (!dragging) return;
    let left = event.clientX - offsetX;
    let top = event.clientY - offsetY;
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
