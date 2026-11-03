const mark = document.createElement('div')
mark.id = 'ext-ok'
mark.textContent = 'EXT OK'
document.body.appendChild(mark)
document.documentElement.dataset.ext = 'loaded'
