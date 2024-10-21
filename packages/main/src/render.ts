import type { Feature, FeatureChild, GherkinDocument, RuleChild, Step } from "@cucumber/messages";
import { type QuickPickleConfig } from '.'

import * as Gherkin from '@cucumber/gherkin';
import * as Messages from '@cucumber/messages';
import { fromPairs, intersection, pick } from "lodash-es";

const uuidFn = Messages.IdGenerator.uuid();
const builder = new Gherkin.AstBuilder(uuidFn);
const gherkinMatcher = new Gherkin.GherkinClassicTokenMatcher();
const gherkinParser = new Gherkin.Parser(builder, gherkinMatcher);
const mdMatcher = new Gherkin.GherkinInMarkdownTokenMatcher();
const mdParser = new Gherkin.Parser(builder, mdMatcher);

export function renderGherkin(src:string, config:QuickPickleConfig, isMarkdown?:boolean) {

  // Parse the raw file into a GherkinDocument
  const gherkinDocument = isMarkdown ? mdParser.parse(src) : gherkinParser.parse(src)

  // Exit if there's no feature or scenarios
  if (!gherkinDocument?.feature || !gherkinDocument.feature?.children?.length) {
    return ''
  }

  return `// Generated by quickpickle
import { test, describe, beforeAll, afterAll } from 'vitest';
import {
  gherkinStep,
  applyBeforeAllHooks,
  applyBeforeHooks,
  applyAfterAllHooks,
  applyAfterHooks,
  getWorldConstructor,
} from 'quickpickle';

let World = getWorldConstructor()

const common = {};

beforeAll(async () => {
  await applyBeforeAllHooks(common);
});

afterAll(async () => {
  await applyAfterAllHooks(common);
});

const afterScenario = async(state) => {
  await applyAfterHooks(state);
}
${renderFeature(gherkinDocument.feature!, config)}
`
}

export function renderFeature(feature:Feature, config:QuickPickleConfig) {

  // Get the feature tags
  let tags = feature.tags.map(t => t.name)

  // Get the background stes and all the scenarios
  let { backgroundSteps, children } = renderChildren(feature.children as FeatureChild[], config, tags)

  let featureName = `${q(feature.keyword)}: ${q(feature.name)}`

  // Render the initScenario function, which will be called at the beginning of each scenario
  return`
const initScenario = async(context, scenario, tags) => {
  let state = new World(context, { feature:'${featureName}', scenario, tags }, ${JSON.stringify(config.worldConfig || {})});
  await state.init();
  state.common = common;
  state.info.feature = '${featureName}';
  state.info.scenario = scenario;
  state.info.tags = [...tags];
  await applyBeforeHooks(state);
${backgroundSteps}
  return state;
}

describe('${q(feature.keyword)}: ${q(feature.name)}', () => {
${children}
});`
}

function isRule(child:FeatureChild|RuleChild): child is FeatureChild {
  return child.hasOwnProperty('rule')
}

function renderChildren(children:RuleChild[]|FeatureChild[], config:QuickPickleConfig, tags:string[], sp = '  ') {

  const output = {
    backgroundSteps: '',
    children: '',
  }

  if (!children.length) return output

  if (children[0].hasOwnProperty('background')) {
    output.backgroundSteps = renderSteps(children.shift()!.background!.steps as Step[], config, sp, '', true)
  }

  for (let child of children) {
    if (isRule(child)) {
      output.children += renderRule(child, config, tags, sp)
    }
    else if (child.hasOwnProperty('scenario')) {
      output.children += renderScenario(child, config, tags, sp)
    }
  }

  return output
}

function renderRule(child:FeatureChild, config:QuickPickleConfig, tags:string[], sp = '  ') {
  tags = [...tags, ...child.rule!.tags.map(t => t.name)]
  let { backgroundSteps, children } = renderChildren(child.rule!.children as RuleChild[], config, tags, sp + '  ')

  return `
${sp}describe('${q(child.rule!.keyword)}: ${q(child.rule!.name)}', () => {

${sp}  const initRuleScenario = async (context, scenario, tags) => {
${sp}    let state = await initScenario(context, scenario, tags);
${sp}    state.info.rule = '${q(child.rule!.name)}';
${backgroundSteps}
${sp}    return state;
${sp}  }

${children}

${sp}});
`
}

function renderScenario(child:FeatureChild, config:QuickPickleConfig, tags:string[], sp = '  ') {
  let initFn = sp.length > 2 ? 'initRuleScenario' : 'initScenario'
  tags = [...tags, ...child.scenario!.tags.map(t => t.name)]

  let todo = tagsMatch(config.todoTags, tags) ? '.todo' : ''
  let skip = tagsMatch(config.skipTags, tags) ? '.skip' : ''
  let fails = tagsMatch(config.failTags, tags) ? '.fails' : ''
  let sequential = tagsMatch(config.sequentialTags, tags) ? '.sequential' : ''
  let concurrent = (!sequential && tagsMatch(config.concurrentTags, tags)) ? '.concurrent' : ''
  let attrs = todo + skip + fails + concurrent + sequential

  // Deal with exploding tags
  let taglists = explodeTags(config.explodeTags as string[][], tags)
  let isExploded = taglists.length > 1 ? true : false
  return taglists.map((tags,explodedIdx) => {

  // For Scenario Outlines with examples
  if (child.scenario!.examples?.[0]?.tableHeader && child.scenario!.examples?.[0]?.tableBody) {

    let paramNames = child.scenario?.examples?.[0].tableHeader?.cells?.map(c => c.value) || []
    let paramValues = child.scenario?.examples?.[0].tableBody.map((r) => {
      return fromPairs(r.cells.map((c,i) => [ paramNames![i], c.value ]))
    })

    function replaceParamNames(t:string, withBraces?:boolean) {
      paramNames.forEach(p => {
        t = t.replace(new RegExp(`<${p}>`, 'g'), (withBraces ? `$\{${p}\}` :  `$${p}`))
      })
      return t
    }

    let describe = q(replaceParamNames(child.scenario?.name ?? ''))
    let name = replaceParamNames(child.scenario?.name ?? '', true).replace(/`/g, '\`')

    return `
${sp}test${attrs}.for(${JSON.stringify(paramValues)})(
${sp}  '${q(child.scenario?.keyword || '')}: ${describe}',
${sp}  async ({ ${paramNames?.join(', ')} }, context) => {
${sp}    let state = await ${initFn}(context, \`${name}\`, ['${tags.join("', '") || ''}']);
${child.scenario?.steps.map((step,idx) => {
  let text = step.text.replace(/`/g, '\\`')
  text = replaceParamNames(text,true)
  return `${sp}    await gherkinStep(\`${text}\`, state, ${step.location.line}, ${idx+1}${isExploded ? `, ${explodedIdx + 1}` : ''});`
}).join('\n')
}
${sp}    await afterScenario(state);
${sp}  }
${sp});
`
  }

  return `
${sp}test${attrs}('${q(child.scenario!.keyword)}: ${q(child.scenario!.name)}', async (context) => {
${sp}  let state = await ${initFn}(context, '${q(child.scenario!.name)}', ['${tags.join("', '") || ''}']);
${renderSteps(child.scenario!.steps as Step[], config, sp + '  ', isExploded ? `${explodedIdx+1}` : '')}
${sp}  await afterScenario(state);
${sp}});
`
  }).join('\n\n')
}

function renderSteps(steps:Step[], config:QuickPickleConfig, sp = '  ', explodedText = '', isBackground:boolean = false) {
  let minus = isBackground ? '-' : ''
  return steps.map((step,idx) => {

    if (step.dataTable) {
      let data = JSON.stringify(step.dataTable.rows.map(r => {
        return r.cells.map(c => c.value)
      }))
      return `${sp}await gherkinStep('${q(step.text)}', state, ${step.location.line}, ${minus}${idx+1}, ${explodedText || 'undefined'}, ${data});`
    }
    else if (step.docString) {
      let data = JSON.stringify(pick(step.docString, ['content','mediaType']))
      return `${sp}await gherkinStep('${q(step.text)}', state, ${step.location.line}, ${minus}${idx+1}, ${explodedText || 'undefined'}, ${data});`
    }

    return `${sp}await gherkinStep('${q(step.text)}', state, ${step.location.line}, ${minus}${idx+1}${explodedText ? `, ${explodedText}` : ''});`
  }).join('\n')
}

/**
 * Escapes quotation marks in a string for the purposes of this rendering function.
 * @param t string
 * @returns string
 */
const q = (t:string) => (t.replace(/'/g, "\\'"))

/**
 * Creates a 2d array of all possible combinations of the items in the input array
 * @param arr A 2d array of strings
 * @returns A 2d array of all possible combinations of the items in the input array
 */
export function explodeArray(arr: string[][]): string[][] {
  if (arr.length === 0) return [[]];
  arr = arr.map(subArr => {
    return subArr.length ? subArr : ['']
  })

  const [first, ...rest] = arr;
  const subCombinations = explodeArray(rest);

  return first.flatMap(item =>
    subCombinations.map(subCombo => [item, ...subCombo].filter(Boolean))
  );
}

/**
 * This function "explodes" any tags in the "explodeTags" setting and returns all possible
 * combinations of all the tags. The theory is that it allows you to write one Scenario that
 * runs multiple times in different ways; e.g. with and without JS or in different browsers.
 *
 * To take this case as an example, if the explodeTags are:
 * ```
 * [
 *   ['nojs', 'js'],
 *   ['firefox', 'chromium', 'webkit'],
 * ]
 * ```
 *
 * And the testTags are:
 * ```
 * ['nojs', 'js', 'snapshot']
 * ```
 *
 * Then the function will return:
 * ```
 * [
 *   ['nojs', 'snapshot'],
 *   ['js', 'snapshot'],
 * ]
 * ```
 *
 * In that case, the test will be run twice.
 *
 * @param explodeTags the 2d array of tags that should be exploded
 * @param testTags the tags to test against
 * @returns a 2d array of all possible combinations of tags
 */
export function explodeTags(explodeTags:string[][], testTags:string[]):string[][] {
  if (!explodeTags.length) return [testTags]
  let tagsToTest = [...testTags]

  // gather a 2d array of items that are shared between tags and each array in explodeTags
  // and then remove those items from the tags array
  const sharedTags = explodeTags.map(tagList => {
    let items = tagList.filter(tag => tagsToTest.includes(tag))
    if (items.length) items.forEach(item => tagsToTest.splice(tagsToTest.indexOf(item), 1))
    return items
  })

  // then, build a 2d array of all possible combinations of the shared tags
  let combined = explodeArray(sharedTags)

  // finally, return the list
  return combined.length ? combined.map(arr => [...tagsToTest, ...arr]) : [testTags]
}

/**
 *
 * @param confTags string[]
 * @param testTags string[]
 * @returns boolean
 */
export function tagsMatch(confTags:string[], testTags:string[]) {
  let tags = intersection(confTags.map(t => t.toLowerCase()), testTags.map(t => t.toLowerCase()))
  return tags?.length ? tags : null
}