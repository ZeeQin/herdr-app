(() => {
  'use strict';
  const data = window.previewData;
  const $ = id => document.getElementById(id);
  const send = message => window.ipc?.postMessage(JSON.stringify({...message, generation: data.generation}));
  $('title').textContent = data.path;
  $('close').onclick = () => send({type: 'close'});
  document.addEventListener('click', event => {
    if (event.target.closest('a')) event.preventDefault();
  });
  if (data.error || data.truncated) {
    $('notice').hidden = false;
    $('notice').textContent = data.error || 'Preview truncated: showing the beginning of this file.';
  }
  const main = $('document');
  function media(viewport, src, prefix = '') {
    viewport.replaceChildren();
    const canvas = document.createElement('div');
    canvas.className = 'canvas';
    const img = document.createElement('img');
    img.alt = data.path;
    img.draggable = false;
    canvas.append(img);
    viewport.append(canvas);
    let scale = 1, fit = true, gestureScale = 1, gesturing = false;
    const label = $(prefix + 'zoom');
    const events = new AbortController();
    function layout() {
      const width = img.naturalWidth * scale, height = img.naturalHeight * scale;
      canvas.style.width = Math.max(width, viewport.clientWidth) + 'px';
      canvas.style.height = Math.max(height, viewport.clientHeight) + 'px';
      img.style.width = width + 'px';
      img.style.height = height + 'px';
      img.style.left = Math.max(0, (viewport.clientWidth - width) / 2) + 'px';
      img.style.top = Math.max(0, (viewport.clientHeight - height) / 2) + 'px';
      label.textContent = Math.round(scale * 100) + '%';
    }
    function zoom(next, x = viewport.clientWidth / 2, y = viewport.clientHeight / 2) {
      next = fit ? Math.min(1, next) : Math.max(.1, Math.min(8, next));
      const px = (viewport.scrollLeft + x - parseFloat(img.style.left || 0)) / scale;
      const py = (viewport.scrollTop + y - parseFloat(img.style.top || 0)) / scale;
      scale = next;
      layout();
      viewport.scrollLeft = px * scale + parseFloat(img.style.left) - x;
      viewport.scrollTop = py * scale + parseFloat(img.style.top) - y;
    }
    function fitImage() {
      fit = true;
      zoom(Math.min(1, viewport.clientWidth / img.naturalWidth, viewport.clientHeight / img.naturalHeight));
    }
    $(prefix + 'fit').onclick = fitImage;
    $(prefix + 'actual').onclick = () => { fit = false; zoom(1); };
    $(prefix + 'minus').onclick = () => { fit = false; zoom(scale / 1.2); };
    $(prefix + 'plus').onclick = () => { fit = false; zoom(scale * 1.2); };
    viewport.onwheel = event => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      if (gesturing) return;
      fit = false;
      const rect = viewport.getBoundingClientRect();
      zoom(scale * Math.exp(-event.deltaY * .01), event.clientX - rect.left, event.clientY - rect.top);
    };
    viewport.addEventListener('gesturestart', event => {event.preventDefault(); gesturing = true; gestureScale = scale;}, {passive:false,signal:events.signal});
    viewport.addEventListener('gesturechange', event => {
      event.preventDefault(); fit = false;
      const rect = viewport.getBoundingClientRect();
      zoom(gestureScale * event.scale, event.clientX - rect.left, event.clientY - rect.top);
    }, {passive:false,signal:events.signal});
    viewport.addEventListener('gestureend', event => {event.preventDefault(); gesturing = false;}, {passive:false,signal:events.signal});
    const observer = new ResizeObserver(() => { if (fit && img.naturalWidth) fitImage(); else layout(); });
    observer.observe(viewport);
    img.onload = fitImage;
    img.onerror = () => { const error = document.createElement('p'); error.className='error'; error.textContent='Image could not be loaded.'; canvas.replaceChildren(error); };
    img.src = src;
    return () => {observer.disconnect(); events.abort();};
  }
  let disposeImage;
  const dialog = $('lightbox');
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    if (dialog.open) dialog.close();
    else send({type: 'close'});
  });
  function openImage(src) {
    disposeImage?.();
    dialog.showModal();
    disposeImage = media($('image-viewport'), src, 'image-');
    $('image-close').focus();
  }
  $('image-close').onclick = () => dialog.close();
  dialog.addEventListener('click', event => {if (event.target === dialog) dialog.close();});
  dialog.addEventListener('close', () => {disposeImage?.(); $('image-viewport').replaceChildren();});
  const blobs = [];
  window.addEventListener('pagehide', () => blobs.forEach(url => URL.revokeObjectURL(url)));
  function imageSource(src) {
    if (/^https?:\/\//i.test(src)) return src;
    const entry = data.images?.[src];
    return typeof entry === 'string' ? entry : entry?.url;
  }
  function imageButton(img, src) {
    img.tabIndex = 0; img.setAttribute('role', 'button');
    img.onclick = () => openImage(src);
    img.onkeydown = event => {if (event.key === 'Enter' || event.key === ' ') {event.preventDefault(); openImage(src);}};
  }
  async function markdown(article) {
    const clean = DOMPurify.sanitize(marked.parse(data.text || ''), {
      FORBID_TAGS: ['style', 'svg', 'math', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'video', 'audio', 'source'],
      FORBID_ATTR: ['style', 'srcset', 'id', 'name', 'autofocus'],
    });
    const template = document.createElement('template');
    template.innerHTML = clean;
    template.content.querySelectorAll('img').forEach(img => {
      const original = img.getAttribute('src') || '';
      const src = imageSource(original);
      if (src) {
        img.src = src;
        imageButton(img, src);
        img.onerror = () => {const error = document.createElement('span'); error.className='error'; error.textContent=`Image unavailable: ${img.alt || original}`; img.replaceWith(error);};
      } else {
        const error = document.createElement('span');
        error.className = 'error'; error.textContent = `Image unavailable: ${img.alt || original}`;
        img.replaceWith(error);
      }
    });
    article.replaceChildren(template.content);
    article.querySelectorAll('pre code:not(.language-mermaid)').forEach(code => { try { hljs.highlightElement(code); } catch {} });
    mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:'dark',suppressErrorRendering:true,flowchart:{htmlLabels:false}});
    let index = 0;
    for (const code of article.querySelectorAll('pre code.language-mermaid')) {
      try {
        const {svg} = await mermaid.render('diagram-' + index++, code.textContent);
        if (!article.isConnected) return;
        const url = URL.createObjectURL(new Blob([svg], {type:'image/svg+xml'}));
        blobs.push(url);
        const img = document.createElement('img'); img.src=url; img.alt='Mermaid diagram'; img.className='mermaid-image';
        imageButton(img, url);
        code.parentElement.replaceWith(img);
      } catch (error) {
        const notice=document.createElement('p'); notice.className='error'; notice.textContent='Diagram could not be rendered: ' + String(error.message || error);
        code.parentElement.before(notice);
      }
    }
  }
  if (data.kind === 'image' || data.kind === 'pdf') {
    main.className = 'media';
    if (data.src) media(main, data.src);
    if (data.kind === 'pdf') {
      $('paging').hidden = false;
      $('page').textContent = `${data.page || 1} / ${data.pages || 1}`;
      $('previous').disabled = !(data.page > 1);
      $('next').disabled = !(data.page < data.pages);
      $('previous').onclick = () => send({type:'page',page:data.page - 1});
      $('next').onclick = () => send({type:'page',page:data.page + 1});
    }
  } else {
    for (const id of ['fit','actual','minus','zoom','plus']) $(id).hidden = true;
    let source = data.kind !== 'markdown';
    function render() {
      main.replaceChildren();
      const article = document.createElement('article'); main.append(article);
      if (source) {
        const pre=document.createElement('pre'), code=document.createElement('code');
        code.textContent=data.text || ''; pre.append(code); article.append(pre);
        if (data.language && hljs.getLanguage(data.language)) { code.className='language-' + data.language; hljs.highlightElement(code); }
      } else markdown(article).catch(error => {article.textContent=String(error);});
      $('source').textContent=source ? 'Rendered' : 'Source';
    }
    if (data.kind === 'markdown') {
      $('source').hidden=false;
      $('source').onclick=() => {source=!source; render();};
    }
    render();
  }
})();
