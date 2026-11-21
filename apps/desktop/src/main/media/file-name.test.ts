import { describe, expect, it } from 'vitest'
import { extensionFor, mediaFileName, slugOf, sourceStem } from './file-name'

describe('extensionFor', () => {
  it('names images and videos by their real type, one extension per type', () => {
    expect(extensionFor('image/png')).toBe('.png')
    expect(extensionFor('image/jpeg')).toBe('.jpg')
    expect(extensionFor('IMAGE/WEBP; charset=binary')).toBe('.webp')
    expect(extensionFor('video/mp4')).toBe('.mp4')
    expect(extensionFor('video/quicktime')).toBe('.mov')
  })

  it('has none for what is neither (a GLB, audio, a PDF)', () => {
    expect(extensionFor('model/gltf-binary')).toBeNull()
    expect(extensionFor('audio/mpeg')).toBeNull()
    expect(extensionFor('application/pdf')).toBeNull()
  })
})

describe('slugOf', () => {
  it('keeps letters and digits of any script, dashes between, lower case', () => {
    expect(slugOf('Sunset over the Bay!')).toBe('sunset-over-the-bay')
    expect(slugOf('  Café / Résumé  ')).toBe('cafe-resume')
    expect(slugOf('東京の夜')).toBe('東京の夜')
    expect(slugOf('../../etc/passwd')).toBe('etc-passwd')
    expect(slugOf('***')).toBe('')
  })

  it('stops at 80 characters without a trailing dash', () => {
    const s = slugOf(`${'a'.repeat(79)} b c`)
    expect(s.length).toBeLessThanOrEqual(80)
    expect(s.endsWith('-')).toBe(false)
  })
})

describe('sourceStem', () => {
  it('names a drop, a Studio file, a meeting shot by id, never by token', () => {
    expect(sourceStem('/drops/d8f2/SECRETTOKEN')).toBe('d8f2')
    expect(sourceStem('/drops/d8f2/SECRETTOKEN/poster')).toBe('d8f2-poster')
    expect(sourceStem('/studio/job7/SECRETTOKEN/thumb')).toBe('job7-thumb')
    expect(sourceStem('/meetings/shots/m1/SECRETTOKEN/3')).toBe('m1-3')
    expect(sourceStem('/artifacts/media/0123456789abcdef0123/SECRETTOKEN')).toBe('0123456789ab')
  })

  it('names a URL by its file name, never its query, and a local file by its name', () => {
    expect(sourceStem('https://cdn.example.com/a/Big%20Cat.JPG?sig=SECRET&exp=1')).toBe('big-cat')
    expect(sourceStem('https://example.com/')).toBe('')
    expect(sourceStem('/Users/ike/Pictures/Shot 1.png')).toBe('shot-1')
    expect(sourceStem('~/clip.mov')).toBe('clip')
    expect(sourceStem(null)).toBe('')
  })
})

describe('mediaFileName', () => {
  const drop = '/drops/d8f2/SECRETTOKEN'

  it('prefers the caption, with the real extension', () => {
    expect(mediaFileName({ caption: 'Demo clip', src: drop, ext: '.mp4', kind: 'video' })).toBe(
      'demo-clip.mp4',
    )
    // A caption that is a file name keeps its stem, not its (possibly wrong) extension.
    expect(mediaFileName({ caption: 'shot.png', src: drop, ext: '.jpg', kind: 'image' })).toBe(
      'shot.jpg',
    )
  })

  it('falls back to the drop id when the caption says nothing', () => {
    for (const caption of [undefined, '', '   ', 'Image', 'Image 2 of 3', 'video 1', 'Photo'])
      expect(mediaFileName({ caption, src: drop, ext: '.png', kind: 'image' })).toBe('d8f2.png')
  })

  it('falls back to the kind for a pasted image', () => {
    expect(mediaFileName({ src: null, ext: '.png', kind: 'image' })).toBe('image.png')
    expect(mediaFileName({ caption: '!!!', src: null, ext: '.MP4', kind: 'video' })).toBe(
      'video.mp4',
    )
  })

  it('never carries a token, a query or a directory', () => {
    const name = mediaFileName({
      caption: '../secret/',
      src: 'https://x.test/p.png?token=SECRET',
      ext: '.png',
      kind: 'image',
    })
    expect(name).toBe('secret.png')
    expect(mediaFileName({ src: drop, ext: '.png', kind: 'image' })).not.toContain('SECRET')
  })
})
