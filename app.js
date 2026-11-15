(() => {
  const $ = (id) => document.getElementById(id);
  const canvas = $('sheetCanvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const preview = $('previewCanvas');
  const previewCtx = preview.getContext('2d', { willReadFrequently: true });
  const box = $('canvasBox');
  const overlay = $('gridOverlay');

  let image = null;
  let zoom = 1;
  let cuts = [];
  let activeCut = -1;
  let hover = null;
  let drag = null;
  let pickingBackground = false;
  let background = null;
  let animationPlaying = false;
  let animationFrame = 0;
  let animationLastTime = 0;
  let animationRequest = null;

  const value = (id) => Math.max(0, Number($(id).value) || 0);
  const cutWidth = () => Math.max(1, value('cellW'));
  const cutHeight = () => Math.max(1, value('cellH'));
  const clamp = (number, min, max) => Math.max(min, Math.min(max, number));

  function pointerPosition(event) {
    const rect = box.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / zoom,
      y: (event.clientY - rect.top) / zoom
    };
  }

  function centeredCut(point) {
    const w = cutWidth();
    const h = cutHeight();
    return {
      x: Math.round(clamp(point.x - w / 2, 0, Math.max(0, image.naturalWidth - w))),
      y: Math.round(clamp(point.y - h / 2, 0, Math.max(0, image.naturalHeight - h))),
      w,
      h
    };
  }

  function cutUnder(point) {
    for (let i = cuts.length - 1; i >= 0; i -= 1) {
      const cut = cuts[i];
      if (point.x >= cut.x && point.x <= cut.x + cut.w && point.y >= cut.y && point.y <= cut.y + cut.h) return i;
    }
    return -1;
  }

  function resizeHandleAt(point, cut) {
    if (!cut) return null;
    const threshold = 9 / zoom;
    const near = (a, b) => Math.abs(a - b) <= threshold;
    const insideX = point.x >= cut.x - threshold && point.x <= cut.x + cut.w + threshold;
    const insideY = point.y >= cut.y - threshold && point.y <= cut.y + cut.h + threshold;
    if (!insideX || !insideY) return null;
    const west = near(point.x, cut.x);
    const east = near(point.x, cut.x + cut.w);
    const north = near(point.y, cut.y);
    const south = near(point.y, cut.y + cut.h);
    if (north && west) return 'nw';
    if (north && east) return 'ne';
    if (south && east) return 'se';
    if (south && west) return 'sw';
    if (north) return 'n';
    if (east) return 'e';
    if (south) return 's';
    if (west) return 'w';
    return null;
  }

  function cursorForHandle(handle) {
    if (handle === 'n' || handle === 's') return 'ns-resize';
    if (handle === 'e' || handle === 'w') return 'ew-resize';
    if (handle === 'nw' || handle === 'se') return 'nwse-resize';
    return 'nesw-resize';
  }

  function resizeCut(cut, handle, point, startPoint, original) {
    const minimum = 2;
    const dx = point.x - startPoint.x;
    const dy = point.y - startPoint.y;
    let left = original.x;
    let right = original.x + original.w;
    let top = original.y;
    let bottom = original.y + original.h;
    if (handle.includes('w')) left = clamp(original.x + dx, 0, right - minimum);
    if (handle.includes('e')) right = clamp(original.x + original.w + dx, left + minimum, image.naturalWidth);
    if (handle.includes('n')) top = clamp(original.y + dy, 0, bottom - minimum);
    if (handle.includes('s')) bottom = clamp(original.y + original.h + dy, top + minimum, image.naturalHeight);
    cut.x = Math.round(left);
    cut.y = Math.round(top);
    cut.w = Math.max(minimum, Math.round(right - left));
    cut.h = Math.max(minimum, Math.round(bottom - top));
  }

  function updateCaptureControls() {
    const cut = activeCut >= 0 ? cuts[activeCut] : null;
    $('captureW').disabled = !cut;
    $('captureH').disabled = !cut;
    if (!cut) {
      $('captureSizeLabel').textContent = 'Nenhum';
      return;
    }
    $('captureW').value = cut.w;
    $('captureH').value = cut.h;
    $('captureW').max = image ? image.naturalWidth : 4096;
    $('captureH').max = image ? image.naturalHeight : 4096;
    $('captureSizeLabel').textContent = `${cut.w} × ${cut.h} px`;
  }

  function groundLine(element, height) {
    if (!$('groundToggle').checked) return;
    const line = document.createElement('span');
    line.className = 'cut-ground';
    line.style.top = '100%';
    element.appendChild(line);
  }

  function renderOverlay() {
    if (!image) return;
    overlay.innerHTML = '';
    overlay.style.width = `${image.naturalWidth}px`;
    overlay.style.height = `${image.naturalHeight}px`;

    if ($('gridToggle').checked) {
      const w = cutWidth();
      const h = cutHeight();
      const gx = value('gapX');
      const gy = value('gapY');
      const ox = value('offsetX');
      const oy = value('offsetY');
      for (let y = oy; y + h <= image.naturalHeight; y += h + gy) {
        for (let x = ox; x + w <= image.naturalWidth; x += w + gx) {
          const cell = document.createElement('div');
          cell.className = 'grid-cell';
          Object.assign(cell.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
          overlay.appendChild(cell);
        }
      }
    }

    cuts.forEach((cut, index) => {
      const element = document.createElement('div');
      element.className = `cut-box${index === activeCut ? ' active' : ''}`;
      Object.assign(element.style, { left: `${cut.x}px`, top: `${cut.y}px`, width: `${cut.w}px`, height: `${cut.h}px` });
      const label = document.createElement('span');
      label.className = 'cut-number';
      label.textContent = `${index + 1} · ${cut.w}×${cut.h}`;
      element.appendChild(label);
      if (index === activeCut) {
        element.style.setProperty('--handle-size', `${8 / zoom}px`);
        ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach((position) => {
          const handle = document.createElement('span');
          handle.className = `resize-handle handle-${position}`;
          element.appendChild(handle);
        });
      }
      groundLine(element, cut.h);
      overlay.appendChild(element);
    });

    if (hover && !drag && !pickingBackground) {
      const element = document.createElement('div');
      element.className = 'hover-cut';
      Object.assign(element.style, { left: `${hover.x}px`, top: `${hover.y}px`, width: `${hover.w}px`, height: `${hover.h}px` });
      groundLine(element, hover.h);
      overlay.appendChild(element);
    }
  }

  function inferBorderColor(targetCtx, width, height) {
    const points = [
      [0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1],
      [Math.floor(width / 2), 0], [Math.floor(width / 2), height - 1],
      [0, Math.floor(height / 2)], [width - 1, Math.floor(height / 2)]
    ];
    const colors = points.map(([x, y]) => Array.from(targetCtx.getImageData(x, y, 1, 1).data).slice(0, 3));
    return colors.reduce((best, candidate) => {
      const score = colors.reduce((sum, color) => {
        const dr = candidate[0] - color[0];
        const dg = candidate[1] - color[1];
        const db = candidate[2] - color[2];
        return sum + dr * dr + dg * dg + db * db;
      }, 0);
      return !best || score < best.score ? { color: candidate, score } : best;
    }, null).color;
  }

  function applyTransparency(targetCtx, width, height, chosenBackground = background) {
    if (!chosenBackground) return;
    const pixels = targetCtx.getImageData(0, 0, width, height);
    const data = pixels.data;
    const tolerance = value('tolerance');
    const transparentLimit = tolerance * tolerance * 3;
    const featherLimit = (tolerance + 25) * (tolerance + 25) * 3;
    for (let i = 0; i < data.length; i += 4) {
      const dr = data[i] - chosenBackground[0];
      const dg = data[i + 1] - chosenBackground[1];
      const db = data[i + 2] - chosenBackground[2];
      const distance = dr * dr + dg * dg + db * db;
      if (distance <= transparentLimit) data[i + 3] = 0;
      else if (distance < featherLimit) {
        data[i + 3] = Math.round(data[i + 3] * Math.min(1, (Math.sqrt(distance) - tolerance * Math.sqrt(3)) / (25 * Math.sqrt(3))));
      }
    }
    targetCtx.putImageData(pixels, 0, 0);
  }

  function contentBounds(targetCtx, width, height) {
    const data = targetCtx.getImageData(0, 0, width, height).data;
    let left = width;
    let top = height;
    let right = -1;
    let bottom = -1;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (data[(y * width + x) * 4 + 3] > 24) {
          left = Math.min(left, x);
          top = Math.min(top, y);
          right = Math.max(right, x);
          bottom = Math.max(bottom, y);
        }
      }
    }
    return right < left ? null : { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
  }

  function drawCut(targetCanvas, cut) {
    const outputWidth = cutWidth();
    const outputHeight = cutHeight();
    targetCanvas.width = outputWidth;
    targetCanvas.height = outputHeight;
    const targetCtx = targetCanvas.getContext('2d', { willReadFrequently: true });
    targetCtx.clearRect(0, 0, outputWidth, outputHeight);
    targetCtx.imageSmoothingEnabled = false;
    const source = document.createElement('canvas');
    source.width = cut.w;
    source.height = cut.h;
    const sourceCtx = source.getContext('2d', { willReadFrequently: true });
    sourceCtx.imageSmoothingEnabled = false;
    sourceCtx.drawImage(image, cut.x, cut.y, cut.w, cut.h, 0, 0, cut.w, cut.h);
    const fitContent = $('fitContentToggle').checked;
    const chosenBackground = background || (fitContent ? inferBorderColor(sourceCtx, cut.w, cut.h) : null);
    applyTransparency(sourceCtx, cut.w, cut.h, chosenBackground);

    if (!fitContent) {
      const ground = clamp(value('groundY'), 1, outputHeight);
      targetCtx.drawImage(source, Math.round((outputWidth - cut.w) / 2), Math.round(ground - cut.h));
      return targetCtx;
    }

    const bounds = contentBounds(sourceCtx, cut.w, cut.h);
    if (!bounds) return targetCtx;
    const padding = Math.min(value('fitPadding'), Math.floor(Math.min(outputWidth, outputHeight) / 3));
    const ground = clamp(value('groundY'), padding + 1, outputHeight - padding);
    const availableWidth = Math.max(1, outputWidth - padding * 2);
    const availableHeight = Math.max(1, ground - padding);
    const scale = Math.min(availableWidth / bounds.w, availableHeight / bounds.h);
    const destinationWidth = Math.max(1, Math.round(bounds.w * scale));
    const destinationHeight = Math.max(1, Math.round(bounds.h * scale));
    const destinationX = Math.round((outputWidth - destinationWidth) / 2);
    const destinationY = Math.round(ground - destinationHeight);
    targetCtx.drawImage(
      source,
      bounds.x, bounds.y, bounds.w, bounds.h,
      destinationX, destinationY, destinationWidth, destinationHeight
    );
    return targetCtx;
  }

  function updatePreview() {
    updateCaptureControls();
    $('selectedCount').textContent = cuts.length;
    $('selectionPill').textContent = `${cuts.length} sprite${cuts.length === 1 ? '' : 's'} selecionado${cuts.length === 1 ? '' : 's'}`;
    $('previewSize').textContent = `${cutWidth()} × ${cutHeight()} PNG`;
    if (!image || activeCut < 0 || !cuts[activeCut]) {
      preview.classList.add('hidden');
      $('previewEmpty').classList.remove('hidden');
      return;
    }
    drawCut(preview, cuts[activeCut]);
    preview.classList.remove('hidden');
    $('previewEmpty').classList.add('hidden');
  }

  function updateAnimationPreview() {
    const animationCanvas = $('animationCanvas');
    if (!image || !cuts.length) {
      animationCanvas.classList.add('hidden');
      $('animationEmpty').classList.remove('hidden');
      $('animationFrameLabel').textContent = '0 / 0';
      if (animationPlaying) stopAnimation();
      return;
    }
    animationFrame = ((animationFrame % cuts.length) + cuts.length) % cuts.length;
    drawCut(animationCanvas, cuts[animationFrame]);
    animationCanvas.classList.remove('hidden');
    $('animationEmpty').classList.add('hidden');
    $('animationFrameLabel').textContent = `${animationFrame + 1} / ${cuts.length}`;
  }

  function animationLoop(timestamp) {
    if (!animationPlaying) return;
    const interval = 1000 / Math.max(1, value('animationFps'));
    if (!animationLastTime) animationLastTime = timestamp;
    if (timestamp - animationLastTime >= interval) {
      animationFrame = cuts.length ? (animationFrame + 1) % cuts.length : 0;
      animationLastTime = timestamp;
      updateAnimationPreview();
    }
    animationRequest = requestAnimationFrame(animationLoop);
  }

  function startAnimation() {
    if (!cuts.length || animationPlaying) return;
    animationPlaying = true;
    animationLastTime = 0;
    $('playAnimation').textContent = 'Ⅱ Pausar';
    animationRequest = requestAnimationFrame(animationLoop);
  }

  function stopAnimation() {
    animationPlaying = false;
    if (animationRequest) cancelAnimationFrame(animationRequest);
    animationRequest = null;
    animationLastTime = 0;
    $('playAnimation').textContent = '▶ Reproduzir';
  }

  function stepAnimation(direction) {
    if (!cuts.length) return;
    stopAnimation();
    animationFrame = (animationFrame + direction + cuts.length) % cuts.length;
    updateAnimationPreview();
  }

  function moveActiveFrame(direction) {
    if (activeCut < 0 || cuts.length < 2) return;
    const target = activeCut + direction;
    if (target < 0 || target >= cuts.length) return;
    [cuts[activeCut], cuts[target]] = [cuts[target], cuts[activeCut]];
    activeCut = target;
    animationFrame = target;
    refresh();
  }

  function refresh() {
    renderOverlay();
    updatePreview();
    updateAnimationPreview();
  }

  function updateOutputSize() {
    const outputHeight = cutHeight();
    $('groundY').max = outputHeight;
    if (value('groundY') > outputHeight) $('groundY').value = outputHeight;
    $('groundValue').textContent = `${value('groundY')} px`;
    refresh();
  }

  function setZoom(next) {
    zoom = clamp(next, 0.2, 5);
    if (!image) return;
    box.style.width = `${image.naturalWidth * zoom}px`;
    box.style.height = `${image.naturalHeight * zoom}px`;
    canvas.style.width = `${image.naturalWidth * zoom}px`;
    canvas.style.height = `${image.naturalHeight * zoom}px`;
    overlay.style.transform = `scale(${zoom})`;
    overlay.style.transformOrigin = 'top left';
    $('zoomLabel').textContent = `${Math.round(zoom * 100)}%`;
    renderOverlay();
  }

  function fitImage() {
    if (!image) return;
    const wrap = $('canvasWrap');
    setZoom(Math.min((wrap.clientWidth - 56) / image.naturalWidth, (wrap.clientHeight - 56) / image.naturalHeight, 3));
  }

  function loadImage(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const url = URL.createObjectURL(file);
    const loaded = new Image();
    loaded.onload = () => {
      image = loaded;
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(image, 0, 0);
      cuts = [];
      activeCut = -1;
      hover = null;
      $('emptyState').classList.add('hidden');
      box.style.display = 'block';
      $('fileInfo').classList.remove('hidden');
      const safeName = file.name.replace(/[<>&]/g, '');
      $('fileInfo').innerHTML = `<div style="margin-top:12px"><b>${safeName}</b><div class="statline"><span>${(file.size / 1024).toFixed(0)} KB</span><span>${image.naturalWidth} × ${image.naturalHeight} px</span></div></div>`;
      $('canvasDimensions').textContent = `${image.naturalWidth} × ${image.naturalHeight} PX`;
      $('status').textContent = 'Imagem carregada. Clique sobre o primeiro sprite.';
      refresh();
      fitImage();
      URL.revokeObjectURL(url);
    };
    loaded.onerror = () => {
      $('status').textContent = 'Não foi possível abrir essa imagem.';
      URL.revokeObjectURL(url);
    };
    loaded.src = url;
  }

  overlay.addEventListener('pointermove', (event) => {
    if (!image) return;
    const point = pointerPosition(event);
    if (drag) {
      const cut = cuts[drag.index];
      if (drag.type === 'resize') {
        resizeCut(cut, drag.handle, point, drag.startPoint, drag.original);
        overlay.style.cursor = cursorForHandle(drag.handle);
      } else {
        cut.x = Math.round(clamp(point.x - drag.offsetX, 0, Math.max(0, image.naturalWidth - cut.w)));
        cut.y = Math.round(clamp(point.y - drag.offsetY, 0, Math.max(0, image.naturalHeight - cut.h)));
        overlay.style.cursor = 'move';
      }
      refresh();
      return;
    }
    const handle = activeCut >= 0 ? resizeHandleAt(point, cuts[activeCut]) : null;
    const existing = cutUnder(point);
    if (handle) {
      hover = null;
      overlay.style.cursor = cursorForHandle(handle);
    } else if (existing >= 0) {
      hover = null;
      overlay.style.cursor = 'move';
    } else {
      hover = centeredCut(point);
      overlay.style.cursor = 'crosshair';
    }
    renderOverlay();
  });

  overlay.addEventListener('pointerleave', () => {
    if (!drag) {
      hover = null;
      overlay.style.cursor = 'crosshair';
      renderOverlay();
    }
  });

  overlay.addEventListener('pointerdown', (event) => {
    if (!image) return;
    const point = pointerPosition(event);
    if (pickingBackground) {
      const x = clamp(Math.floor(point.x), 0, canvas.width - 1);
      const y = clamp(Math.floor(point.y), 0, canvas.height - 1);
      const pixel = ctx.getImageData(x, y, 1, 1).data;
      background = [pixel[0], pixel[1], pixel[2]];
      $('bgSwatch').style.background = `rgb(${background.join(',')})`;
      $('bgColorText').textContent = `RGB ${background.join(', ')}`;
      $('pickBgButton').textContent = '◎  Trocar cor de fundo';
      $('status').textContent = 'Cor escolhida. Confira o resultado na prévia.';
      pickingBackground = false;
      refresh();
      return;
    }

    const handle = activeCut >= 0 ? resizeHandleAt(point, cuts[activeCut]) : null;
    const existing = cutUnder(point);
    if (handle) {
      const cut = cuts[activeCut];
      drag = {
        type: 'resize',
        index: activeCut,
        handle,
        startPoint: point,
        original: { x: cut.x, y: cut.y, w: cut.w, h: cut.h }
      };
    } else if (existing >= 0) {
      activeCut = existing;
      const cut = cuts[existing];
      drag = { type: 'move', index: existing, offsetX: point.x - cut.x, offsetY: point.y - cut.y };
    } else {
      const cut = centeredCut(point);
      cuts.push(cut);
      activeCut = cuts.length - 1;
      drag = { type: 'move', index: activeCut, offsetX: point.x - cut.x, offsetY: point.y - cut.y };
      $('status').textContent = `Recorte ${cuts.length} adicionado. Use as alças brancas para cortar os espaços extras.`;
    }
    overlay.setPointerCapture(event.pointerId);
    refresh();
  });

  overlay.addEventListener('pointerup', (event) => {
    if (!drag) return;
    const changedCut = cuts[drag.index];
    drag = null;
    overlay.style.cursor = 'crosshair';
    if (overlay.hasPointerCapture(event.pointerId)) overlay.releasePointerCapture(event.pointerId);
    if (changedCut) $('status').textContent = `Área capturada: ${changedCut.w} × ${changedCut.h} px. Saída: ${cutWidth()} × ${cutHeight()} px.`;
    refresh();
  });

  function makePng(cut) {
    const output = document.createElement('canvas');
    drawCut(output, cut);
    return new Promise((resolve) => output.toBlob(resolve, 'image/png'));
  }

  const fileName = (index) => `sprite_${String(index + 1).padStart(3, '0')}.png`;

  async function exportFolder() {
    if (!cuts.length) {
      $('status').textContent = 'Adicione pelo menos um recorte.';
      return;
    }
    if (!window.showDirectoryPicker) {
      await exportZip();
      return;
    }
    try {
      const directory = await window.showDirectoryPicker({ mode: 'readwrite' });
      for (let i = 0; i < cuts.length; i += 1) {
        const handle = await directory.getFileHandle(fileName(i), { create: true });
        const writer = await handle.createWritable();
        await writer.write(await makePng(cuts[i]));
        await writer.close();
      }
      $('status').textContent = `${cuts.length} PNG(s) salvos na pasta escolhida.`;
    } catch (error) {
      if (error.name !== 'AbortError') $('status').textContent = 'Falha ao salvar na pasta. Tente baixar como ZIP.';
    }
  }

  const crcTable = (() => {
    const table = [];
    for (let n = 0; n < 256; n += 1) {
      let code = n;
      for (let k = 0; k < 8; k += 1) code = code & 1 ? 0xedb88320 ^ (code >>> 1) : code >>> 1;
      table[n] = code >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let code = 0xffffffff;
    for (const byte of bytes) code = crcTable[(code ^ byte) & 255] ^ (code >>> 8);
    return (code ^ 0xffffffff) >>> 0;
  }

  function zipStore(entries) {
    const encoder = new TextEncoder();
    const files = [];
    const central = [];
    let offset = 0;
    for (const entry of entries) {
      const name = encoder.encode(entry.name);
      const data = new Uint8Array(entry.data);
      const crc = crc32(data);
      const local = new Uint8Array(30 + name.length);
      const localView = new DataView(local.buffer);
      localView.setUint32(0, 0x04034b50, true);
      localView.setUint16(4, 20, true);
      localView.setUint32(14, crc, true);
      localView.setUint32(18, data.length, true);
      localView.setUint32(22, data.length, true);
      localView.setUint16(26, name.length, true);
      local.set(name, 30);
      files.push(local, data);
      const directory = new Uint8Array(46 + name.length);
      const directoryView = new DataView(directory.buffer);
      directoryView.setUint32(0, 0x02014b50, true);
      directoryView.setUint16(4, 20, true);
      directoryView.setUint16(6, 20, true);
      directoryView.setUint32(16, crc, true);
      directoryView.setUint32(20, data.length, true);
      directoryView.setUint32(24, data.length, true);
      directoryView.setUint16(28, name.length, true);
      directoryView.setUint32(42, offset, true);
      directory.set(name, 46);
      central.push(directory);
      offset += local.length + data.length;
    }
    const centralSize = central.reduce((sum, item) => sum + item.length, 0);
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(8, entries.length, true);
    endView.setUint16(10, entries.length, true);
    endView.setUint32(12, centralSize, true);
    endView.setUint32(16, offset, true);
    return new Blob([...files, ...central, end], { type: 'application/zip' });
  }

  async function exportZip() {
    if (!cuts.length) {
      $('status').textContent = 'Adicione pelo menos um recorte.';
      return;
    }
    const button = $('zipButton');
    button.disabled = true;
    $('status').textContent = 'Preparando os PNGs…';
    try {
      const entries = [];
      for (let i = 0; i < cuts.length; i += 1) {
        const png = await makePng(cuts[i]);
        if (!png || !png.size) throw new Error('O navegador não conseguiu gerar o PNG.');
        entries.push({ name: `sprites/${fileName(i)}`, data: await png.arrayBuffer() });
      }
      const url = URL.createObjectURL(zipStore(entries));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'sprites_recortados.zip';
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      $('status').textContent = `ZIP pronto com ${entries.length} sprite(s).`;
    } catch (error) {
      $('status').textContent = 'Não foi possível gerar o ZIP.';
    } finally {
      button.disabled = false;
    }
  }

  $('openButton').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (event) => loadImage(event.target.files[0]));
  const dropZone = $('dropZone');
  dropZone.addEventListener('dragover', (event) => { event.preventDefault(); dropZone.classList.add('over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('over'));
  dropZone.addEventListener('drop', (event) => { event.preventDefault(); dropZone.classList.remove('over'); loadImage(event.dataTransfer.files[0]); });

  ['cellW', 'cellH'].forEach((id) => $(id).addEventListener('input', updateOutputSize));
  ['captureW', 'captureH'].forEach((id) => $(id).addEventListener('input', () => {
    if (!image || activeCut < 0 || !cuts[activeCut]) return;
    const cut = cuts[activeCut];
    if (id === 'captureW') cut.w = Math.round(clamp(value(id), 2, image.naturalWidth - cut.x));
    else cut.h = Math.round(clamp(value(id), 2, image.naturalHeight - cut.y));
    refresh();
  }));
  ['gapX', 'gapY', 'offsetX', 'offsetY'].forEach((id) => $(id).addEventListener('input', renderOverlay));
  $('gridToggle').addEventListener('change', () => { $('gridOptions').classList.toggle('hidden', !$('gridToggle').checked); renderOverlay(); });
  $('selectionColor').addEventListener('input', () => {
    document.documentElement.style.setProperty('--selection', $('selectionColor').value);
  });
  $('groundY').addEventListener('input', () => { $('groundValue').textContent = `${value('groundY')} px`; refresh(); });
  $('groundToggle').addEventListener('change', renderOverlay);
  $('tolerance').addEventListener('input', () => { $('tolValue').textContent = $('tolerance').value; updatePreview(); updateAnimationPreview(); });
  $('fitContentToggle').addEventListener('change', () => { updatePreview(); updateAnimationPreview(); });
  $('fitPadding').addEventListener('input', () => {
    $('fitPaddingValue').textContent = `${value('fitPadding')} px`;
    updatePreview();
    updateAnimationPreview();
  });
  $('pickBgButton').addEventListener('click', () => {
    if (!image) { $('status').textContent = 'Carregue uma imagem primeiro.'; return; }
    pickingBackground = true;
    hover = null;
    $('pickBgButton').textContent = 'Clique na cor de fundo…';
    $('status').textContent = 'Clique em um pixel branco do fundo da spritesheet.';
    renderOverlay();
  });
  $('removeSelection').addEventListener('click', () => {
    if (activeCut < 0) return;
    cuts.splice(activeCut, 1);
    activeCut = cuts.length ? Math.min(activeCut, cuts.length - 1) : -1;
    refresh();
  });
  $('frameEarlier').addEventListener('click', () => moveActiveFrame(-1));
  $('frameLater').addEventListener('click', () => moveActiveFrame(1));
  $('playAnimation').addEventListener('click', () => { if (animationPlaying) stopAnimation(); else startAnimation(); });
  $('previousFrame').addEventListener('click', () => stepAnimation(-1));
  $('nextFrame').addEventListener('click', () => stepAnimation(1));
  $('animationFps').addEventListener('input', () => {
    $('fpsValue').textContent = `${value('animationFps')} FPS`;
    animationLastTime = 0;
  });
  $('clearSelection').addEventListener('click', () => { cuts = []; activeCut = -1; refresh(); });
  $('zoomIn').addEventListener('click', () => setZoom(zoom * 1.2));
  $('zoomOut').addEventListener('click', () => setZoom(zoom / 1.2));
  $('fitButton').addEventListener('click', fitImage);
  $('exportButton').addEventListener('click', exportFolder);
  $('zipButton').addEventListener('click', exportZip);
  window.addEventListener('resize', () => { if (image) fitImage(); });
})();
