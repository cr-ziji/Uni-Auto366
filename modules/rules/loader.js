const moduleLog = require('../logging').create('规则');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

function generateId(name) {
  return crypto.createHash('md5').update(name).digest('hex');
}

class RulesLoader {
  constructor(appPath) {
    this.appPath = appPath || process.cwd();
    this.rulesetsDir = path.join(this.appPath, 'rulesets');
  }

  async loadBuiltinRulesets(rulesManager) {
    try {
      if (rulesManager.loadError) {
        moduleLog.error('原规则文件读取失败，跳过内置规则写入，避免覆盖用户数据');
        return;
      }
      await this._ensureAnswerRuleset(rulesManager);

      if (!fs.existsSync(this.rulesetsDir)) {
        moduleLog.log('内置规则集目录不存在:', this.rulesetsDir);
        return;
      }

      const folders = fs.readdirSync(this.rulesetsDir).filter(item => {
        const itemPath = path.join(this.rulesetsDir, item);
        return fs.statSync(itemPath).isDirectory();
      });

      for (const folderName of folders) {
        const folderPath = path.join(this.rulesetsDir, folderName);
        const rulesetJsonPath = path.join(folderPath, 'ruleset.json');
        const rulesJsonPath = path.join(folderPath, `${folderName}.json`);

        if (!fs.existsSync(rulesetJsonPath) || !fs.existsSync(rulesJsonPath)) {
          moduleLog.log(`跳过不完整的规则集: ${folderName}`);
          continue;
        }

        try {
          const rulesetInfo = JSON.parse(fs.readFileSync(rulesetJsonPath, 'utf-8'));
          const builtinVersion = rulesetInfo.version || 0;

          const currentRulesets = rulesManager.getRules();
          const existingRuleset = currentRulesets.find(rs =>
            rs.isBuiltin && rs.name === rulesetInfo.name
          );

          const localVersion = existingRuleset ? (existingRuleset.version || 0) : -1;

          if (existingRuleset && localVersion >= builtinVersion) {
            this.rebaseBuiltinPaths(existingRuleset, folderPath, rulesManager);
            moduleLog.log(`内置规则集版本一致，跳过: ${rulesetInfo.name} (v${localVersion})`);
            continue;
          }

          const needUpdate = existingRuleset && localVersion < builtinVersion;
          if (needUpdate) {
            moduleLog.log(`内置规则集版本更新: ${rulesetInfo.name} v${localVersion} -> v${builtinVersion}`);
          }

          let rulesData = JSON.parse(fs.readFileSync(rulesJsonPath, 'utf-8'));

          rulesData = rulesData.map(rule => {
            for (const field of ['zipImplant', 'injectScript', 'newContentFile']) {
              if (rule[field]) {
                rule[field] = this._resolveRuleAsset(folderPath, rule[field], rulesetInfo.name, rule.name, field);
              }
            }
            if (Array.isArray(rule.injectScripts)) {
              rule.injectScripts = rule.injectScripts.map(value =>
                this._resolveRuleAsset(folderPath, value, rulesetInfo.name, rule.name, 'injectScripts')
              );
            }
            return rule;
          });

          const hasInjectionRules = rulesData.some(rule =>
            rule.type === 'zip-implant' || rule.type === 'zip-implant-dynamic'
          );
          const autoCompatible = !hasInjectionRules;
          const finalCompatible = rulesetInfo.compatible !== undefined
            ? rulesetInfo.compatible
            : autoCompatible;

          const rulesetId = existingRuleset ? existingRuleset.id : generateId(rulesetInfo.name);

          const rules = rulesData.map(rule => {
            const { groupId, isGroup, ...ruleData } = rule;
            const previous = existingRuleset?.rules?.find(item => item.id === generateId(rule.name) || item.name === rule.name);
            return {
              ...ruleData,
              id: generateId(rule.name),
              isBuiltin: true,
              enabled: previous ? previous.enabled !== false : rule.enabled !== false,
              createdAt: rule.createdAt || new Date().toISOString(),
              updatedAt: rule.updatedAt || new Date().toISOString()
            };
          });

          const preservedEnabled = existingRuleset ? existingRuleset.enabled : false;

          const newRuleset = {
            id: rulesetId,
            name: rulesetInfo.name,
            description: rulesetInfo.description,
            isBuiltin: true,
            enabled: preservedEnabled,
            compatible: finalCompatible,
            version: builtinVersion,
            createdAt: existingRuleset ? existingRuleset.createdAt : new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            rules: rules
          };

          let updatedRulesets;
          if (existingRuleset) {
            updatedRulesets = rulesManager.getRules().map(rs =>
              rs.id === existingRuleset.id ? newRuleset : rs
            );
          } else {
            updatedRulesets = rulesManager.getRules();
            const isNewRulesetCompatible = rulesetInfo.compatible !== undefined ? rulesetInfo.compatible : false;
            if (newRuleset.enabled && !isNewRulesetCompatible) {
              updatedRulesets = updatedRulesets.map(rs => {
                if (rs.compatible === false && rs.enabled) {
                  moduleLog.log(`关闭不兼容规则集: ${rs.name}`);
                  return { ...rs, enabled: false };
                }
                return rs;
              });
            }
            updatedRulesets = [...updatedRulesets, newRuleset];
          }

          if (!rulesManager.saveRules(updatedRulesets)) throw new Error('规则保存失败');

          const action = needUpdate ? '更新' : '导入';
          moduleLog.log(`成功${action}内置规则集: ${rulesetInfo.name} v${builtinVersion} (${rules.length} 个规则)`);
        } catch (error) {
          moduleLog.error(`导入规则集 ${folderName} 失败:`, error);
        }
      }

      moduleLog.log('内置规则集导入完成');
    } catch (error) {
      moduleLog.error('导入内置规则集失败:', error);
    }
  }

  /**
   * Rewrites a rule asset reference to its absolute path inside the rule set.
   *
   * Remote URLs and already absolute paths are returned untouched. A relative
   * reference that does not resolve to a file keeps its original value, but it
   * is reported: such a rule stays enabled in the UI while `injection/` skips
   * it (`if (!await fs.pathExists(rule.zipImplant)) continue;`), so the user
   * only saw "the rule does nothing" with no hint about the real cause.
   */
  _resolveRuleAsset(folderPath, value, rulesetName, ruleName, field) {
    if (typeof value !== 'string' || !value || /^https?:/i.test(value) || path.isAbsolute(value)) {
      return value;
    }
    const candidate = path.join(folderPath, value);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    moduleLog.warn(`规则集「${rulesetName}」的规则「${ruleName}」引用了不存在的文件: ${value} (${field})`);
    return value;
  }

  rebaseBuiltinPaths(ruleset, folderPath, rulesManager) {
    let changed = false;
    const marker = '/rulesets/' + path.basename(folderPath) + '/';
    const rebase = value => {
      if (typeof value !== 'string' || /^https?:/i.test(value)) return value;
      const normalized = value.replace(/\\/g, '/');
      const position = normalized.lastIndexOf(marker);
      // Only relocate bundled assets. Custom absolute paths are not replaced.
      if (position < 0) return value;
      const target = path.resolve(folderPath, normalized.slice(position + marker.length));
      if (!target.startsWith(path.resolve(folderPath) + path.sep) || !fs.existsSync(target) || target === value) return value;
      changed = true;
      return target;
    };
    for (const rule of ruleset.rules || []) {
      for (const key of ['zipImplant', 'injectScript', 'newContentFile']) if (rule[key]) rule[key] = rebase(rule[key]);
      if (Array.isArray(rule.injectScripts)) rule.injectScripts = rule.injectScripts.map(rebase);
    }
    if (changed && !rulesManager.saveRules()) throw new Error('内置资源路径更新保存失败');
  }

  async _ensureAnswerRuleset(rulesManager) {
    const currentRulesets = rulesManager.getRules();
    const existing = currentRulesets.find(rs =>
      rs.isBuiltin && rs.name === '内置-答案获取'
    );

    if (!existing) {
      const answerRuleset = {
        id: generateId('内置-答案获取'),
        name: '内置-答案获取',
        description: '程序内置的空规则集，仅用于答案获取功能',
        isBuiltin: true,
        enabled: true,
        compatible: false,
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        rules: []
      };

      if (!rulesManager.saveRules([...currentRulesets, answerRuleset])) throw new Error('内置答案规则保存失败');
      moduleLog.log('成功导入内置规则集: 内置-答案获取 (0 个规则)');
    }
  }
}

module.exports = RulesLoader;
