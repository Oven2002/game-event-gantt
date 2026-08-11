function registerDrag() {
    const element = document.getElementById('waifu');
    if (!element)
        return () => { };
    let winWidth = window.innerWidth;
    let winHeight = window.innerHeight;
    let imgWidth = element.offsetWidth;
    let imgHeight = element.offsetHeight;
    let dragging = false;
    let startClientX = 0;
    let startClientY = 0;
    let startLeft = 0;
    let startTop = 0;
    const handleMouseDown = (event) => {
        if (event.button === 2 || event.target !== document.getElementById('live2d'))
            return;
        event.preventDefault();
        dragging = true;
        startClientX = event.clientX;
        startClientY = event.clientY;
        const computed = getComputedStyle(element);
        startLeft = parseFloat(computed.left) || 0;
        startTop = parseFloat(computed.top) || 0;
        element.style.left = `${startLeft}px`;
        element.style.top = `${startTop}px`;
        element.style.right = 'auto';
        element.style.bottom = 'auto';
    };
    const handleMouseMove = (event) => {
        if (!dragging)
            return;
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
