import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
import * as fse from 'fs-extra'
import * as cp from 'child_process'
import { tmpdir } from 'os'
import { promisify } from 'util'

import { Extension } from '../main'
import { stripComments } from '../utils'

const removeDir = promisify(fse.remove)

interface IFileTikzCollection {
    texFileLocation: string
    tempDir: string
    tikzPictures: IFileTikzPicture[]
    preamble: string
    lastChange: number
}

interface IFileTikzPicture {
    range: vscode.Range
    content: string
    tempFile: string
    lastChange: number
}

export class TikzPictureView {
    extension: Extension
    tikzCollections: { [filePath: string]: IFileTikzCollection } = {}
    initalised = false

    private TEMPFOLDER_NAME = 'vscode-latexutils'

    constructor(extension: Extension) {
        this.extension = extension
    }

    public async view(document: vscode.TextDocument, range: vscode.Range) {
        this.extension.logger.addLogMessage(`Viewing TikZ Picture starting on line ${range.start.line + 1}`)
        this.extension.telemetryReporter.sendTelemetryEvent('tikzpreview')

        if (!this.initalised) {
            await this.cleanupTempDir()
            if (!fs.existsSync(path.join(tmpdir(), this.TEMPFOLDER_NAME))) {
                await fs.mkdirSync(path.join(tmpdir(), this.TEMPFOLDER_NAME))
            }
            this.initalised = true
        }

        const fileTikzCollection = await this.getFileTikzCollection(document)

        const tikzPicture = await this.getTikzEntry(fileTikzCollection, {
            range,
            content: document.getText(range)
        })

        const preambleStatus = await this.checkPreamble(fileTikzCollection, range.start.line)

        if (preambleStatus === 'stable') {
            this.updateTikzPicture(tikzPicture)
        }
    }

    public async onFileChange(
        document: vscode.TextDocument,
        changes: readonly vscode.TextDocumentContentChangeEvent[],
        waitedDelay?: boolean
    ) {
        const tikzFileCollection = this.tikzCollections[document.uri.fsPath]

        const tikzConfig = vscode.workspace.getConfiguration('latex-utilities.tikzpreview')
        const changeDelay = tikzConfig.get('delay') as number
        if (changeDelay === 0 || tikzFileCollection === undefined) {
            return
        } else if (+new Date() - tikzFileCollection.lastChange < changeDelay) {
            if (!waitedDelay) {
                tikzFileCollection.lastChange = +new Date()
                setTimeout(() => {
                    this.onFileChange(document, changes, true)
                }, changeDelay)
            }
            return
        }

        tikzFileCollection.lastChange = +new Date()

        if (+new Date() - tikzFileCollection.lastChange > (tikzConfig.get('timeout') as number)) {
            return
        }

        this.checkPreamble(tikzFileCollection)

        const tikzPictures: IFileTikzPicture[] = tikzFileCollection.tikzPictures
        const tikzPicturesToUpdate: IFileTikzPicture[] = []

        for (const tikzPicture of tikzPictures) {
            // if viewer is closed, we remove preview.
            if (
                !this.extension.workshop.viewer.getClientSet(
                    vscode.Uri.file(tikzPicture.tempFile.replace(/\.tex$/, '.pdf').toLocaleUpperCase())
                ) || this.extension.workshop.viewer.getClientSet(
                    vscode.Uri.file(tikzPicture.tempFile.replace(/\.tex$/, '.pdf').toLocaleUpperCase())
                )?.size === 0
            ) {
                tikzPictures.splice(tikzPictures.indexOf(tikzPicture), 1)
                this.cleanupTikzPicture(tikzPicture)
                continue
            }

            for (const change of changes) {
                const lineDelta = change.text.split('\n').length - 1 - (change.range.end.line - change.range.start.line)
                if (tikzPicture.range.end.isBefore(change.range.start)) {
                    // change after tikzpicture
                    continue
                } else if (tikzPicture.range.start.isAfter(change.range.end)) {
                    // change before tikzpicture
                    tikzPicture.range = new vscode.Range(
                        tikzPicture.range.start.translate(lineDelta, 0),
                        tikzPicture.range.end.translate(lineDelta, 0)
                    )
                } else if (
                    change.range.end.isAfter(tikzPicture.range.start) &&
                    change.range.end.line - lineDelta < tikzPicture.range.start.line
                ) {
                    // tikzpicture removed
                    tikzPictures.splice(tikzPictures.indexOf(tikzPicture), 1)
                    this.cleanupTikzPicture(tikzPicture)
                } else {
                    // tikzpicture modified
                    this.processModificationToTikzPicture(document, tikzPicture, change, lineDelta)
                    // recompile if currently viewed
                    if (!tikzPicturesToUpdate.includes(tikzPicture)) {
                        tikzPicturesToUpdate.push(tikzPicture)
                    }
                }
            }
        }
        tikzPicturesToUpdate.forEach(tikzP => {
            this.updateTikzPicture(tikzP)
        })
    }
    private processModificationToTikzPicture(
        document: vscode.TextDocument,
        tikzPicture: IFileTikzPicture,
        change: vscode.TextDocumentContentChangeEvent,
        lineDelta: number
    ) {
        let startLocation: vscode.Position | null = null
        if (change.range.start.line <= tikzPicture.range.start.line) {
            const startLine = document.lineAt(tikzPicture.range.start.line)
            const tikzPictureStartIndex = stripComments(startLine.text, '%').search(
                /\\begin{(?:tikzpicture|\w*tikz\w*)}/
            )
            if (tikzPictureStartIndex !== -1) {
                startLocation = tikzPicture.range.start.translate(
                    0,
                    tikzPictureStartIndex - tikzPicture.range.start.character
                )
            } else {
                const startRegex = /\\begin{(?:tikzpicture|\w*tikz\w*)}/
                let startMatch: RegExpMatchArray | null = null
                let lineNo = change.range.start.line - 1
                do {
                    startMatch = document.lineAt(++lineNo).text.match(startRegex)
                } while (!startMatch && lineNo <= tikzPicture.range.end.line)

                if (startMatch && startMatch.index !== undefined) {
                    startLocation = new vscode.Position(lineNo, startMatch.index)
                }
            }
        }

        let endLocation: vscode.Position | null = null
        if (change.range.end.line >= tikzPicture.range.end.line) {
            // things can be a bit funny so we'll just look for the matchin \end{tikzpicture}
            const endRegex = /\\end{(?:tikzpicture|\w*tikz\w*)}/
            let endMatch: RegExpMatchArray | null = null
            let lineNo = tikzPicture.range.start.line - 1
            do {
                endMatch = stripComments(document.lineAt(++lineNo).text, '%').match(endRegex)
            } while (!endMatch && lineNo <= change.range.end.line)

            if (endMatch && endMatch.index !== undefined) {
                endLocation = new vscode.Position(lineNo, endMatch.index + endMatch[0].length)
            }
        }

        tikzPicture.range = new vscode.Range(
            startLocation ? startLocation : tikzPicture.range.start,
            endLocation ? endLocation : tikzPicture.range.end.translate(lineDelta, 0)
        )
        tikzPicture.content = document.getText(tikzPicture.range)
    }

    private async updateTikzPicture(tikzPicture: IFileTikzPicture) {
        fs.writeFileSync(tikzPicture.tempFile, `%&preamble\n\\begin{document}\n${tikzPicture.content}\n\\end{document}`)

        const startTime = +new Date()

        try {
            cp.execSync(`latexmk "${path.basename(tikzPicture.tempFile)}" -interaction=batchmode -quiet -pdf`, {
                cwd: path.dirname(tikzPicture.tempFile),
                stdio: 'ignore'
            })
            console.log(`Took ${+new Date() - startTime}ms to recompile tikzpicture`)
        } catch (error) {
            console.log('latexmk failed to compile standalone tikzpicture')
        }

        if (
            this.extension.workshop.viewer.getClientSet(
                vscode.Uri.file(tikzPicture.tempFile.replace(/\.tex$/, '.pdf').toLocaleUpperCase())
            ) && this.extension.workshop.viewer.getClientSet(
                vscode.Uri.file(tikzPicture.tempFile.replace(/\.tex$/, '.pdf').toLocaleUpperCase())
            )?.size !== 0
        ) {
            // now that refreshExistingViewer will always refresh the viewer,
            // we won't need to check if it is refreshed.
            // See: James-Yu/LaTeX-Workshop@003be53ee5398df7429eddb30c6ffe3b1ef06ca2
            this.extension.workshop.viewer.refreshExistingViewer(tikzPicture.tempFile)
        } else {
            this.extension.workshop.viewer.openTab(tikzPicture.tempFile, false, true)
        }
    }

    private async getFileTikzCollection(document: vscode.TextDocument): Promise<IFileTikzCollection> {
        if (!(document.uri.fsPath in this.tikzCollections)) {
            const tempDir: string = fs.mkdtempSync(
                path.join(tmpdir(), this.TEMPFOLDER_NAME, `tikzpreview-${path.basename(document.uri.fsPath, '.tex')}-`)
            )

            const thisFileTikzCollection: IFileTikzCollection = {
                texFileLocation: document.uri.fsPath,
                tempDir,
                tikzPictures: [],
                preamble: '',
                lastChange: +new Date()
            }

            this.tikzCollections[document.uri.fsPath] = thisFileTikzCollection
        }

        return this.tikzCollections[document.uri.fsPath]
    }

    private async getTikzEntry(
        tikzCollection: IFileTikzCollection,
        tikzPictureContent: {
            range: vscode.Range
            content: string
        }
    ): Promise<IFileTikzPicture> {
        for (const tikzPicture of tikzCollection.tikzPictures) {
            if (tikzPicture.range.isEqual(tikzPictureContent.range)) {
                return tikzPicture
            }
        }

        const tempFile: string = path.join(tikzCollection.tempDir, `tikzpicture-${+new Date() % 100000000}.tex`)

        tikzCollection.tikzPictures.push({
            range: tikzPictureContent.range,
            content: tikzPictureContent.content,
            tempFile,
            lastChange: +new Date()
        })

        return tikzCollection.tikzPictures[tikzCollection.tikzPictures.length - 1]
    }

    private async checkPreamble(fileTikzCollection: IFileTikzCollection, maxParsedLine?: number) {
        const generatedPreamble = await this.generatePreamble(fileTikzCollection, maxParsedLine)
        if (fileTikzCollection.preamble !== generatedPreamble) {
            // eslint-disable-next-line require-atomic-updates
            fileTikzCollection.preamble = generatedPreamble
            await this.precompilePreamble(
                path.join(fileTikzCollection.tempDir, 'preamble.tex'),
                fileTikzCollection.preamble
            )
            const recompilePromises = fileTikzCollection.tikzPictures.map(tikzPicture =>
                this.updateTikzPicture(tikzPicture)
            )
            await Promise.all(recompilePromises)
            return 'updated'
        }
        return 'stable'
    }

    private async generatePreamble(fileTikzCollection: IFileTikzCollection, maxParsedLine?: number) {
        const configuration = vscode.workspace.getConfiguration('latex-utilities.tikzpreview')
        let commandsString = ''
        const newCommandFile = configuration.get('preambleContents') as string
        if (newCommandFile !== '') {
            if (path.isAbsolute(newCommandFile)) {
                if (fs.existsSync(newCommandFile)) {
                    commandsString = await fs.readFileSync(newCommandFile, { encoding: 'utf8' })
                }
            } else {
                const rootDir = this.extension.workshop.manager.rootDir()
                const newCommandFileAbs = path.join(rootDir, newCommandFile)
                if (fs.existsSync(newCommandFileAbs)) {
                    commandsString = await fs.readFileSync(newCommandFileAbs, { encoding: 'utf8' })
                }
            }
        }
        commandsString = commandsString.replace(/^\s*$/gm, '')
        if (!configuration.get('parseTeXFile') as boolean) {
            return commandsString
        }
        const regex = /(\\usepackage(?:\[[^\]]*\])?{(?:\w*tikz\w*|pgfplots|xcolor)}|\\(?:tikzset|pgfplotsset){(?:[^{}]+|{(?:[^{}]+|{(?:[^{}]+|{[^{}]+})+})+})+}|\\(?:usetikzlibrary|usepgfplotslibrary){[^}]+}|\\definecolor{[^}]+}{[^}]+}{[^}]+}|\\colorlet{[^}]+}{[^}]+})/gm
        const commands: string[] = []

        let content = await fs.readFileSync(fileTikzCollection.texFileLocation, { encoding: 'utf8' })
        content = content.replace(/([^\\]|^)%.*$/gm, '$1') // Strip comments

        if (maxParsedLine) {
            const nthIndex = (str: string, pat: string, n: number) => {
                const L = str.length
                let i = -1
                while (n-- && i++ < L) {
                    i = str.indexOf(pat, i)
                    if (i < 0) {
                        break
                    }
                }
                return i
            }
            content = content.substring(0, nthIndex(content, '\n', maxParsedLine))
        } else {
            content = content.split('\\begin{document}')[0]
        }

        let result: RegExpExecArray | null
        do {
            result = regex.exec(content)
            if (result) {
                commands.push(result[1])
            }
        } while (result)
        let preamble = commandsString + '\n' + commands.join('\n')
        preamble = preamble.includes('\\usepackage{tikz}') ? preamble : '\n\\usepackage{tikz}\n' + preamble
        // extra includes
        let tikzFileUnixPath = fileTikzCollection.texFileLocation
        if (process.platform === 'win32') {
            tikzFileUnixPath = tikzFileUnixPath.replace(/\\/g, '/')
        }
        const texFileParentFolder = tikzFileUnixPath.replace(/\/[^/.]+\.\w+$/, '')
        preamble += `\\pgfplotsset{table/search path={${texFileParentFolder}}}`
        preamble += '\n\n\\pdfcompresslevel=0\n\\pdfobjcompresslevel=0'
        return preamble
    }

    private precompilePreamble(file: string, preamble: string) {
        return new Promise<void>((resolve, reject) => {
            fs.writeFileSync(file, `\\documentclass{standalone}\n\n${preamble}\n\n\\begin{document}\\end{document}`)
            const process = cp.exec(
                `pdftex -ini -interaction=nonstopmode -shell-escape -file-line-error -jobname="preamble" "&pdflatex" mylatexformat.ltx ${path.basename(
                    file
                )}`,
                { cwd: path.dirname(file) }
            )
            process.on('exit', () => {
                resolve()
            })
            process.on('error', err => {
                reject(err)
            })
        })
    }

    private async cleanupTikzPicture(tikzPicture: IFileTikzPicture) {
        cp.execSync(`latexmk -C "${path.basename(tikzPicture.tempFile)}"`, {
            cwd: path.dirname(tikzPicture.tempFile),
            stdio: 'ignore'
        })
        fs.unlinkSync(tikzPicture.tempFile)
    }

    public async cleanupTempFiles() {
        const rmPromises: Promise<any>[] = []
        for (const tikzCollection in this.tikzCollections) {
            rmPromises.push(removeDir(this.tikzCollections[tikzCollection].tempDir))
        }
        await Promise.all(rmPromises)
    }

    public async cleanupTempDir() {
        await fse.removeSync(path.join(tmpdir(), this.TEMPFOLDER_NAME))
    }
}
