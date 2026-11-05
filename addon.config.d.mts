declare const addonConfig: {
  id: string
  directoryName: string
  name: string
  description: string
  version: string
  author: string | string[]
  image: string
  banner: string
  libraryLogo: string
  tags: string[]
  dependencies: string[]
  allowedUrls: string[]
  supportedVersions: string[]
  requirements: { minHostApi?: number; capabilities?: string[] }
}
export default addonConfig
