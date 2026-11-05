/**
 * Direct image links in what Isaac typed. A pasted `https://host/pic.webp` should show as a picture in his
 * own bubble, not as a link, on the phone and on desktop. Pure, so both apps share the rule.
 */

/** An http(s) URL whose path ends in an image extension (query and fragment allowed). */
const IMAGE_URL =
  /https?:\/\/[^\s<>"')\]]+?\.(?:png|jpe?g|gif|webp|avif|bmp|svg)(?:\?[^\s<>"')\]]*)?(?:#[^\s<>"')\]]*)?(?=$|[\s<>"')\].,;!?])/gi

export interface UserImageUrls {
  /** The image URLs, in order, without repeats. */
  urls: string[]
  /** The text with those URLs taken out (trimmed); empty when the message was only image links. */
  rest: string
}

export function userImageUrls(text: string): UserImageUrls {
  const urls: string[] = []
  const rest = text
    .replace(IMAGE_URL, (url) => {
      if (!urls.includes(url)) urls.push(url)
      return ''
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
  return urls.length === 0 ? { urls, rest: text } : { urls, rest }
}
