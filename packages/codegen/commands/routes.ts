import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, relative, join } from 'node:path'
import { BaseCommand } from '@adonisjs/core/ace'
import { Node, Project, QuoteKind } from 'ts-morph'
import type { MethodDeclaration, SourceFile } from 'ts-morph'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { parseBindingReference } from '@adonisjs/core/helpers'
import type { Router } from '@adonisjs/core/http'
import { RouteJSON } from '@adonisjs/core/types/http'
// @ts-ignore
import matchit from '@poppinss/matchit'

type HandlerData = { method: MethodDeclaration; body: Node }
type RouteReferenceParsed = Awaited<ReturnType<typeof parseBindingReference>>
type SerializedRoute = {
  name?: string
  path: string
  params?: Array<string>
}

export default class CodegenTypes extends BaseCommand {
  static commandName = 'codegen:types:routes'
  static description = 'Generate the routes.d.ts file with routes request and response types'

  static options: CommandOptions = { startApp: true }

  #destination!: URL
  #project!: Project

  #getDestinationDirectory() {
    return dirname(this.#destination.pathname)
  }

  async #prepareDestination() {
    this.#destination = new URL('./.adonisjs/types/api.d.ts', this.app.appRoot)
    const directory = this.#getDestinationDirectory()
    if (!existsSync(directory)) {
      await mkdir(directory)
    }
  }

  /**
   * Get routes from the router instance
   */
  async #getRoutes() {
    const router = await this.app.container.make('router')
    router.commit()

    return router.toJSON().root
  }

  /**
   * We have multiple ways to get the request payload :
   * - First we check if a FormRequest is used
   * - Other we check if we have a Single Action Controller
   * - Otherwise, we check if a request.validateUsing is used
   *
   * This method will returns the path to the schema file
   */
  #extractRequest(handlerData: HandlerData) {
    /**
     * 1. Search for a call to validateUsing in the controller
     */
    const validateUsingCallNode = handlerData.method.forEachDescendant((node) => {
      if (!Node.isCallExpression(node)) return false

      if (node.getExpression().getText().includes('validateUsing')) {
        return node
      }

      return false
    })

    if (validateUsingCallNode) {
      const schema = validateUsingCallNode.getArguments()[0]
      if (!Node.isIdentifier(schema)) return

      const importPath = schema.getImplementations()[0].getSourceFile().getFilePath()
      const relativeImportPath = relative(this.#getDestinationDirectory(), importPath)

      return `Infer<typeof import('${relativeImportPath}')['${schema.getText()}']>`
    }
  }

  /**
   * Generate the final interface containing all routes, request, and response
   */
  #generateFinalInterface(types: Record<string, any>, indent = '  ') {
    let interfaceContent = ''

    Object.entries(types).forEach(([key, value]) => {
      if (typeof value === 'object') {
        interfaceContent += `${indent}'${key}': {\n`
        interfaceContent += this.#generateFinalInterface(value, indent + '  ')
        interfaceContent += `${indent}};\n`
      } else {
        interfaceContent += `${indent}'${key}': ${value};\n`
      }
    })

    return interfaceContent
  }

  /**
   * Write the final interface containing all routes, request, and response
   * in a routes.d.ts file
   */
  async #writeFinalInterface(types: Record<string, any>) {
    const file = this.#project.addSourceFileAtPathIfExists(fileURLToPath(this.#destination))
    if (!file) throw new Error('Unable to create the routes.d.ts file')

    file?.removeText()

    file.insertText(0, (writer) => {
      writer
        .writeLine(`import type { Serialize, Simplify } from '@adonisjs/codegen/types'`)
        .writeLine(`import type { Infer } from '@vinejs/vine/types'`)
        .newLine()
        .writeLine(`export interface AdonisApi {`)
        .write(this.#generateFinalInterface(types, '  '))
        .writeLine(`}`)
    })

    await file.save()
  }

  extractRouteInfo(routes: RouteJSON[]) {
    return routes
      .map((route) => {
        // type != 0 === dynamic
        const params = matchit
          .parse(route.pattern)
          .filter((node: any) => node.type !== 0)
          .map((node: any) => node.val)

        return {
          params,
          name: route.name,
          path: route.pattern,
        }
      })
      .filter((route) => !!route.name)
  }

  /**
   * Extract class and method of the route handler
   */
  #extractClassHandlerData(
    file: SourceFile,
    routeHandler: RouteReferenceParsed
  ): HandlerData | undefined {
    const classDef = file.getClasses()[0]
    if (!classDef) return

    const method = classDef.getMethod(routeHandler.method)
    if (!method) return

    const body = method.getBody()
    if (!body) return

    return { method, body }
  }

  /**
   * Execute command
   */
  async run() {
    this.#project = new Project({
      tsConfigFilePath: new URL('./tsconfig.json', this.app.appRoot).pathname,
      manipulationSettings: { quoteKind: QuoteKind.Single },
    })

    await this.#prepareDestination()
    const routes = await this.#getRoutes()
    const sourcesFiles = this.#project.getSourceFiles()

    const types: Record<string, any> = {}
    for (const route of routes) {
      /**
       * We don't support inline functions
       */
      if (typeof route.handler === 'function') continue

      /**
       * Get the controller file associated with this route
       */
      const routeHandler = await parseBindingReference(route.handler.reference)
      const file = sourcesFiles.find((sf) =>
        sf.getFilePath().endsWith(`${routeHandler.moduleNameOrPath.replace('#', '')}.ts`)
      )

      if (!file) continue

      /**
       * Extract the class and method of the controller
       */
      const handlerData = this.#extractClassHandlerData(file, routeHandler)
      if (!handlerData) continue

      /**
       * Extract the request schema associated with this route
       */
      const schemaImport = this.#extractRequest(handlerData)

      /**
       * Get the methods associated with this route
       */
      const methods = route.methods
        .map((method) => method.toLowerCase())
        .filter((method) => method !== 'head')

      const segments = route.pattern.split('/').filter(Boolean) as string[]

      let currentLevel = types
      const relativePath = relative(this.#getDestinationDirectory(), file.getFilePath())
      segments.forEach((segment, i) => {
        if (!currentLevel[segment]) {
          currentLevel[segment] = {}
        }

        currentLevel = currentLevel[segment]

        if (i === segments.length - 1) {
          for (const method of methods) {
            currentLevel[method] = {
              request: schemaImport ?? 'unknown',
              response: `Simplify<Serialize<Awaited<ReturnType<typeof import('${relativePath}').default['prototype']['${routeHandler.method}']>>>>`,
            }
          }
        }
      })
    }

    await this.#writeFinalInterface(types)

    const raw = this.extractRouteInfo(routes)

    const output = JSON.stringify(raw, null, '\t')
    const outputPath = join(this.#getDestinationDirectory(), 'routes.ts')

    const content = [
      `export const routes = ${output} as const;`,
      'export type Routes = typeof routes;',
      `export type Route = Routes[number];`,
      `export type RouteWithName = Extract<Route, { name: string }>;`,
      `export type RouteWithParams = Extract<Route, { params: ReadonlyArray<string> }>;`,
    ].join('\n\n')

    await writeFile(outputPath, content)

    await writeFile(join(this.#getDestinationDirectory(), 'routes.ts'), content, 'utf-8')
  }
}