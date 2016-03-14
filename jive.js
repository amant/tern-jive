(function(mod) {
	if (typeof exports === 'object' && typeof module === 'object') // CommonJS
		return mod(require('tern/lib/infer'), require('tern/lib/tern'), require('acorn'), require('acorn/dist/walk'));
	if (typeof define === 'function' && define.amd) // AMD
		return define(['tern/lib/infer', 'tern/lib/tern', 'acorn/dist/acorn.js', 'acorn/dist/walk.js']);

	mod(tern, tern, acorn, acorn.walk);
})(function(infer, tern, acorn, walk) {
	'use strict';

	// Constants
	var PROPERTY_TYPE = 'type',
		PROPERTY_LIBRARY_COMPONENT_ID = 'libraryComponentId',
		PROPERTY_PROTOTYPE = 'prototype',
		PROPERTY_PROPERTIES = 'properties',
		PROPERTY_SETTINGS = 'settings',
		PROPERTY_DEFAULT_SETTINGS = 'defaultSettings',
		PROPERTY_COMPONENTS = 'components',
		PROPERTY_STYLE = 'style',
		PROPERTY_BODY_STYLE = 'bodyStyle',
		OBJ_LIBRARY = 'Library',
		OBJ_SITES = 'Sites',
		OBJ_CONSTRUCTS = 'Constructs',
		OBJ_PACKAGES = 'Packages',
		OBJ_DEFINITION = 'Definition',
		OBJ_DP = '_DP',
		NO_JIVE_EXPRESSION = 'NoJiveExpression',
		JIVE_THIS_EXPRESSION = 'JiveThisExpression',
		JIVE_BOOL_EXPRESSION = 'JiveBoolExpression',
		JIVE_KEY_VALUE_DATA_EXPRESSION = 'JiveKeyValueDataExpression',
	  INJECT_VARIABLE_DECLARATION = '_DP.Definition.Library.__$=';

	// Returns server variable
	function getServer() {
		return infer.cx().parent;
	}

	function isFullPath(uri) {
		return uri.charAt(0) === '/' || uri.charAt(1) === ':';
	}

	function isWinPath(uri) {
		return uri.charAt(1) === ':';
	}

	function getFullPath(uri) {
		if (isFullPath(uri)) {
			return uri;
		}

		var projectDir = getServer().projectDir;
		var fullPath = projectDir + uri;

		if (isWinPath(projectDir)) {
			// convert `/` to '\'
			fullPath = fullPath.replace(/\//g, '\\');
		}

		return fullPath;
	}

	function isNodeJs() {
		return typeof process !== 'undefined';
	}

	function isJSONFile(filename) {
		var name = filename.split('.');
		return (name[name.length - 1].toLowerCase() === 'json');
	}

	// Returns generated compponent id
	function generateComponentId() {
		return 'someId' + Math.random().toString().substr(-2);
	}

	// Return variable's type
	function getTypeName(type) {
		return type && type.name ? type.name === 'Array' ? '[]' : type.name : 'object';
	}

	function isNodeValueEmpty(node) {
		return node.value.name && node.value.name.length === 1 && node.value.name.charCodeAt(0) === 10006 // x
	}

	function isPropertyValueEmpty(property) {
		return property && property.node.type === 'Property' && isNodeValueEmpty(property.node);
	}

	// Parses comments that starts off as `//@import hello.js`, and return file name
	function getImportFiles(text) {
		var matches = text.match(/^\/\/@import .+?$/gm);
		if (matches) {
			return matches.map(function(val) {
				var importFile = val.split(' ');
				if (importFile[1]) {
					return importFile[1];
				}
			});
		}
		return [];
	}

	// Define jive plugin
	tern.registerPlugin('jive', function(server, options) {
		server.mod._jive = {
			options: options || {}
		};

		server.on('completion', findCompletions);

		server.on('preParse', function(text, options) {
			// insert a library definition variable into Jive Package JSON string, so Acorn will parse JSON as JS and output ast
			return isJSONFile(options.directSourceFile.name) ? INJECT_VARIABLE_DECLARATION + text : text;
		});

		// load imported files eg: `//@import hello.js`
		if (isNodeJs) {
			server.on('postParse', function(ast, text) {
				getImportFiles(text).forEach(function(importFileName) {
					if (!server.fileMap[importFileName]) {
						server.addFile(importFileName);
					}
				});
			});
		}

		// add jive definitions
		server.addDefs(defs);
		// add css style definitions
		server.addDefs(defs_css);
	});

	// Handler for plugin's autocomplete
	function findCompletions(file, query) {
		var wordStart = tern.resolvePos(file, query.end),
			wordEnd = wordStart,
			startPos, endPos, word, completionSets;

		// get starting word position
		while (wordStart && acorn.isIdentifierChar(file.text.charCodeAt(wordStart - 1))) {
			--wordStart;
		}
		startPos = tern.outputPos(query, file, wordStart), endPos = tern.outputPos(query, file, wordEnd);

		// get the word user has typed
		word = file.text.slice(wordStart, wordEnd);

		// check if cursor is inside an object expression
		var jiveExpr = findJiveExpression(file, wordEnd);

		if (!jiveExpr || jiveExpr === NO_JIVE_EXPRESSION) return;

		// check if there are any completionSets
		completionSets = completeModuleName(jiveExpr, word, file);

		return {
			start: startPos,
			end: endPos,
			isProperty: true,
			isObjectKey: true,
			completions: (query.types || query.docs || query.urls || query.origins) ? completionSets : completionSets.map(function(n) {
				return n.name;
			})
		};
	}

	// Check if node is paret of a Jive Definition Object
	function isJiveDefinition(immediateParent) {
		var isJiveDefinition = false;

		if (immediateParent && immediateParent.type) {
			switch (immediateParent.type) {
				case 'AssignmentExpression':
					// check if it's `_DP.Definition`.*.* = { }
					var isDP = immediateParent.left.object && immediateParent.left.object.object && immediateParent.left.object.object.object && immediateParent.left.object.object.object.name === OBJ_DP;
					var isDefinition = isDP && immediateParent.left.object.object.property.name === OBJ_DEFINITION;
					isJiveDefinition = isDP && isDefinition;
					break;

				case 'Property':
					// check if jive component has been defined
					var parentKey = immediateParent && immediateParent.key ? immediateParent.key : null;
					isJiveDefinition = Boolean(getJiveComponent(immediateParent, immediateParent.sourceFile) || parentKey);
					break;
			}
		}

		return isJiveDefinition;
	}

	// Returns type of jive expression
	function findJiveExpression(file, wordEnd) {
		var expr = null,
			expressionFn = [getMemberExpr, getValueForTypeProperty, getValueForProperty, getParentNode];

		// compenset for the injected variable on json file when walking down ast
		if (isJSONFile(file.name)) {
			wordEnd += INJECT_VARIABLE_DECLARATION.length;
		}

		for (var i = 0, max = expressionFn.length; i < max; i++) {
			expr = expressionFn[i]();
			if (expr) {
				break;
			}
		}

		return expr;

		// --- helper functions ---

		// Check if it's a member expression, and property `Library.`
		function getMemberExpr() {
			var memberExpr = infer.findExpressionAround(file.ast, null, wordEnd, file.scope, 'MemberExpression');

			if (memberExpr && memberExpr.node.type === 'MemberExpression') {

				// when `this` object is found within jive definition, inject Context of jive component within that block scope
				if (memberExpr.state.fnType && memberExpr.node.object.type === 'ThisExpression') {
					var jiveComponent = _getJiveComponent(memberExpr.state.originNode, file);
					if (jiveComponent) {
						return {
							type: JIVE_THIS_EXPRESSION,
							jiveComponent: jiveComponent,
							node: memberExpr.state.originNode
						}
					}
				}

				return (memberExpr.node.object.property &&
					(memberExpr.node.object.property.name === OBJ_SITES || memberExpr.node.object.property.name === OBJ_CONSTRUCTS || memberExpr.node.object.property.name === OBJ_PACKAGES || memberExpr.node.object.property.name === OBJ_LIBRARY)) ? memberExpr.node : NO_JIVE_EXPRESSION;
			}

			return null;
		}

		function _getJiveComponent(node) {
			var depth = 0,
				property, objExpr, parentProperty, jiveComponent;

			property = infer.parentNode(node, file.ast);

			while (++depth < 5 && !jiveComponent) {
				objExpr = infer.parentNode(property, file.ast);
				parentProperty = (objExpr && objExpr.type === 'ObjectExpression') ? infer.parentNode(objExpr, file.ast) : null;
				jiveComponent = parentProperty && getJiveComponent(parentProperty, file);
				property = parentProperty
			}

			return jiveComponent;
		}

		// Check if it's `'type': ''` object literal property
		function getValueForTypeProperty() {
			var literalExpr = walk.findNodeAround(file.ast, wordEnd),
				propertyNode;

			if (literalExpr && literalExpr.node.type === 'Literal') {
				propertyNode = walk.findNodeBefore(file.ast, wordEnd + 1);
				if (propertyNode) {
					return propertyNode.node;
				}
			}

			return;
		}

		// Check if there any value or properties possible within object expression
		function getValueForProperty() {
			var property = walk.findNodeAround(file.ast, wordEnd);
			var objExpr = (property && property.node.type === 'Property') ? infer.parentNode(property.node, file.ast) : null;
			var parentProperty = (objExpr && objExpr.type === 'ObjectExpression') ? infer.parentNode(objExpr, file.ast) : null;
			var jiveComponent = parentProperty && getJiveComponent(parentProperty, file);

			if (jiveComponent) {
				// check if property value is boolean or has other matching property values
				var fns = [getBoolType, getPropertyValueDataType];
				for (var i = 0, max = fns.length; i < max; i++) {
					var result = fns[i](jiveComponent, parentProperty, property);
					if (result) {
						return result;
					}
				}
			}

			return;
		}

		// Returns type of the jive component's property
		function getPropertyType(jiveComponent, parentProperty, property) {
			var keyName = parentProperty.key.name || parentProperty.key.value;
			var propertyName = (keyName === PROPERTY_SETTINGS) ? PROPERTY_DEFAULT_SETTINGS : keyName;
			var jiveDefinition = infer.cx().definitions.jive[jiveComponent];
			var type;

			// match property of component and get it's type
			infer.forAllPropertiesOf(jiveDefinition, function(prop, obj) {
				if (prop === propertyName) {
					infer.forAllPropertiesOf(obj.props[propertyName], function(innerProp, innerObj) {
						if (innerProp === property.node.key.name || innerProp === property.node.key.value) {
							type = innerObj.props[innerProp].getType();
						}
					});
				}
			});

			return type;
		}

		function getBoolType(jiveComponent, parentProperty, property) {
			var type = getPropertyType(jiveComponent, parentProperty, property);

			if (type && type.name === 'bool') {
				return {
					type: JIVE_BOOL_EXPRESSION,
					node: null
				};
			}

			return;
		}

		function getPropertyValueDataType(jiveComponent, parentProperty, property) {
			var keyValueDataType;

			// check if there is key value mapping defined for given key
			var keyNode = getJiveDefKeyNode(jiveComponent, parentProperty, property);
			var keyData = keyNode && keyNode['!data'];

			if (keyData) {
				// walk over mapped values
				var mappedPath = keyData.split('.');
				var component = mappedPath.length && mappedPath.shift();
				var componentObj = component && infer.cx().definitions.jive[component];
				var aType = componentObj && componentObj.getType();

				if (aType) {
					for (var i = 0, len = mappedPath.length; i < len; i++) {
						aType = aType.props[mappedPath[i]].getType();
					}

					keyValueDataType = {
						type: JIVE_KEY_VALUE_DATA_EXPRESSION,
						node: aType
					};
				}
			}

			return keyValueDataType;
		}

		// Returns non ast jive definition json structure
		function getJiveDef() {
			var srv = getServer(),
				def = null;

			for (var i = srv.defs.length - 1; i >= 0; i--) {
				if (srv.defs[i]['!name'] === 'jive') {
					def = srv.defs[i]['!define'];
					break;
				}
			}

			return def;
		}

		function getJiveDefKeyNode(jiveComponent, parentProperty, property) {
			var def = getJiveDef();
			var keyName = (parentProperty.key.name === PROPERTY_SETTINGS || parentProperty.key.value === PROPERTY_SETTINGS) ? PROPERTY_DEFAULT_SETTINGS : (parentProperty.key.name || parentProperty.key.value);
			var parent = def && def[jiveComponent][keyName];
			return parent && parent[property.node.key.name || property.node.key.value];
		}

		function getParentNode() {
			var objExpr, immediateParent;

			objExpr = infer.findExpressionAround(file.ast, null, wordEnd, file.scope, 'ObjectExpression');

			// Check if cursor is inside object's key
			if (objExpr) {
				immediateParent = infer.parentNode(objExpr.node, file.ast);
			}

			return immediateParent && isJiveDefinition(immediateParent) ? immediateParent : null;
		}
	}

	// Returns completion set for different type of jive expression
	function completeModuleName(jiveExpr, word, file) {
		var filterCompletion = {},
			completionSets = [],
			cx = infer.cx(),
			isJSON = isJSONFile(file.name);

		switch (jiveExpr.type) {
			case 'AssignmentExpression':
				var objType = jiveExpr.left.object.property.name;
				infer.forAllPropertiesOf(cx.definitions.jive.JiveDefinition.props[objType], gatherCompletionSet);
				break;
			case 'Property':
				if (jiveExpr.key.name === PROPERTY_TYPE || jiveExpr.key.value === PROPERTY_TYPE) {
					gatherJiveComponentNames();

				} else if (jiveExpr.key.name === PROPERTY_COMPONENTS || jiveExpr.key.value === PROPERTY_COMPONENTS) {
					if (word === '') {
						var name = generateComponentId();
						completionSets = [{
							displayName: name,
							name: getName(name)
						}];
					}

				} else if (jiveExpr.key.name === PROPERTY_STYLE ||
										jiveExpr.key.name === PROPERTY_BODY_STYLE ||
											jiveExpr.key.value === PROPERTY_STYLE ||
												jiveExpr.key.value === PROPERTY_BODY_STYLE) {
					infer.forAllPropertiesOf(cx.definitions.CSSStyle.CSSStyle, gatherCompletionSet);

				} else if (infer.parentNode(jiveExpr, file.ast).objType.name === PROPERTY_COMPONENTS) {
					infer.forAllPropertiesOf(cx.definitions.jive.JiveDefinition.props.Library, gatherCompletionSet);

				} else {
					var component = getJiveComponent(jiveExpr, file);
					console.log('JiveComponent:', component);

					if (component && jiveExpr.key) {
						gatherCompletionSetForComponent(component, jiveExpr.key.name || jiveExpr.key.value);
					} else if (jiveExpr.value.type === 'ObjectExpression') {
						gatherCompletionSetForObjectExpression(jiveExpr, file);
						if (!completionSets.length) {
							infer.forAllPropertiesOf(cx.definitions.jive.JiveDefinition.props.Library, gatherCompletionSet);
						}
					}
				}
				break;
			case JIVE_KEY_VALUE_DATA_EXPRESSION:
				gatherPropertyValue();
				break;
			case JIVE_BOOL_EXPRESSION:
				gatherBoolValue();
				break;
			case JIVE_THIS_EXPRESSION:
				gatherCompletionSetForComponent(jiveExpr.jiveComponent, PROPERTY_PROTOTYPE);
				break;
			case 'MemberExpression':
				if (word === '') {
					var name = generateComponentId();
					completionSets = [{
						name: name,
						displayName: getName(name)
					}];
				}
				break;
			default:
				completionSets = [];
		}

		return completionSets;

		// -- helper functions -- //
		function getName(name) {
			return isJSON ? '"' + name + '": ' : name;
		}

		function gatherPropertyValue() {
			for (var k in jiveExpr.node.props) {
				var prop = jiveExpr.node.props[k];
				completionSets.push({
					name: '_DP.ComponentTypes.' + jiveExpr.node.name + '.' + prop.propertyName,
					type: getTypeName(prop.getType())
				});
			}
		}

		function gatherJiveComponentNames() {
			for (var prop in cx.definitions.jive) {
				if (prop === 'JiveDefinition' || prop.indexOf(word) !== 0) {
					continue;
				}

				if (!(prop in filterCompletion)) {
					filterCompletion[prop] = true;
					completionSets.push({
						name: prop
					});
				}
			}
		}

		function gatherCompletionSet(prop, obj) {
			var aval, type, completionObj, srv = getServer();
			// remove hasOwnProperty, and other noisy functions
			if (obj === srv.cx.protos.Object || prop.indexOf(word) !== 0) {
				return;
			}

			aval = obj && obj.props[prop];
			type = aval && aval.getType();

			completionObj = {
				'name': getName(prop),
				'displayName': prop,
				'type': getTypeName(type),
				'doc': aval.doc || ''
			};

			if (!(prop in filterCompletion)) {
				filterCompletion[prop] = true;
				completionSets.push(completionObj);
			}
		}

		function gatherCompletionSetForProperties(prop, obj, depth, addInfo) {
			if (prop === PROPERTY_PROPERTIES) {
				infer.forAllPropertiesOf(obj.props[prop], gatherCompletionSet);
			}
		}

		function gatherCompletionSetForSettings(prop, obj, depth, addInfo) {
			if (prop === PROPERTY_DEFAULT_SETTINGS) {
				infer.forAllPropertiesOf(obj.props[prop], gatherCompletionSet);
			}
		}

		function gatherCompletionSetForPrototype(prop, obj, depth, addInfo) {
			if (prop === PROPERTY_PROTOTYPE) {
				infer.forAllPropertiesOf(obj.props[prop], gatherCompletionSet);
			}
		}

		function gatherCompletionSetForComponent(componentName, keyName) {
			if (componentName && keyName) {
				if (cx.definitions.jive[componentName]) {
					if (keyName === PROPERTY_PROPERTIES) {
						infer.forAllPropertiesOf(cx.definitions.jive[componentName], gatherCompletionSetForProperties);

					} else if (keyName === PROPERTY_SETTINGS) {
						infer.forAllPropertiesOf(cx.definitions.jive[componentName], gatherCompletionSetForSettings);

					} else if (keyName === PROPERTY_PROTOTYPE) {
						infer.forAllPropertiesOf(cx.definitions.jive[componentName], gatherCompletionSetForPrototype);
					}
				}
			}
		}

		function gatherBoolValue() {
			var values = ['true', 'false'];
			for (var i = 0; i < values.length; i++) {
				if (word === '') {
					completionSets.push({
						name: values[i],
						type: 'bool'
					});
				}
			}
		}

		function gatherCompletionSetForObjectExpression(jiveExpr, file) {
			var parent = infer.parentNode(jiveExpr, file.ast);
			var grandParent = parent && infer.parentNode(parent, file.ast);
			var component = grandParent && getJiveComponent(grandParent, file);
			if (component) {
				infer.forAllPropertiesOf(infer.cx().definitions.jive[component], function(prop, obj) {
					// matches `properties`
					if (prop === grandParent.key.name || prop === grandParent.key.value) {
						infer.forAllPropertiesOf(obj.props[prop], function(prop2, obj2) {
							// matches key name
							if (prop2 === jiveExpr.key.name || prop2 === jiveExpr.key.value) {
								infer.forAllPropertiesOf(obj2.props[prop2], gatherCompletionSet);
							}
						});
					}
				});
			}
		}
	}

	// Return type of jive component
	function getJiveComponent(node, file) {
		var rootParent = infer.parentNode(node, file.ast),
			componentName = '',
			componentId = '',
			srv = getServer(),
			importedFiles = [],

			// find component name in `type: 'JiveComponent'`,
			// key.name when it's an Identifier type eg: `type:``, and key.value when it's a Literal eg: `"type"`:
			getComponentFromTypeKey = function(expr) {
				if (expr.type === 'Property' && (expr.key.name === PROPERTY_TYPE || expr.key.value === PROPERTY_TYPE)) {
					componentName = expr.value.value;
					return true;
				}
			},

			// find component id in `libraryComponentId: 'id-name'`
			getComponentIdFromLibraryComponentId = function(expr) {
				if (expr.type === 'Property' && (expr.key.name === PROPERTY_LIBRARY_COMPONENT_ID || expr.key.value === PROPERTY_LIBRARY_COMPONENT_ID)) {
					componentId = expr.value.value;
					return true;
				}
			},

			// find component name in `type: 'JiveComponent'` within one of the imported files that matches libraryComponentId
			getComponentFromLibraryComponentId = function(importFileName) {
				var importFile = srv.fileMap[getFullPath(importFileName)] || srv.fileMap[importFileName];

				if (importFile) {
					walk.simple(importFile.ast, {
						AssignmentExpression: function(expr) {
							if (!componentName && expr.operator === '=' && expr.left.property.type === 'Identifier' && expr.left.property.name === componentId) {
								expr.right.properties.some(getComponentFromTypeKey);
							}
						}
					});
				}
			},

			// find component name in an object literal property within one of the imported files that maches parent property name
			getComponentFromObjectPropertyName = function(importFileName) {
				var importFile = srv.fileMap[getFullPath(importFileName)] || srv.fileMap[importFileName];

				if (importFile) {
					walk.simple(importFile.ast, {
						Property: function(expr) {
							if (!componentName && expr.value.type === 'ObjectExpression' && expr.key.name === rootParent.objType.name) {
								expr.value.properties.some(getComponentFromTypeKey);
							}
						}
					});
				}
			};

		if (rootParent && rootParent.properties) {
			// find jive component in `type: value`
			rootParent.properties.some(getComponentFromTypeKey);

			// find jive component in `libraryComponentId`
			if (!componentName) {
				rootParent.properties.some(getComponentIdFromLibraryComponentId);

				if (componentId) {
					importedFiles = getImportFiles(file.text);
					importedFiles.forEach(getComponentFromLibraryComponentId);
				}
			}

			// check if it exists within one of the server fileMaps
			if (!componentName) {
				importedFiles = importedFiles.length ? importedFiles : getImportFiles(file.text);
				importedFiles.forEach(getComponentFromObjectPropertyName);
			}
		}

		return componentName;
	}

	// Jive framework definition structure
	var defs = {
		'!name': 'jive',
		'!define': {
			// Jive Dashboard Definition Optional Properties:
			JiveDefinition: {
				Library: {
					type: {
						'!type': 'string',
						'!doc': 'Component Type, eg: Image, Button',
						'!url': 'http://gfk.com'
					},
					properties: {
						'!doc': 'An object containing properties for the component'
					},
					settings: {
						'!doc': 'An object containing settings for the component and its children'
					},
					libraryComponentId: {
						'!type': 'string',
						'!doc': 'A string referencing a node id in the component library'
					},
					coreComponentId: {
						'!type': 'string',
						'!doc': 'A string referencing a node id in the core component library'
					},
					linkedComponents: {
						'!type': '[]',
						'!doc': 'Specific for widgets: an array containing name(s) of component(s) this widget links to'
					},
					linkedComponent: {
						'!type': 'string',
						'!doc': 'Specific for widgets: a string containing the name of a component this widget links to'
					},
					dataRequests: {
						'!type': '[]',
						'!doc': 'Specific for widgets: an array containing one or more dataRequest definitions'
					},
					components: {
						'!doc': 'An object containing child components'
					},
					parentComponent: {
						'!type': 'string',
						'!doc': 'A string containing the componentId of this component\'s parent component. Overrides the hierarchical structure (if this component is part of another component\'s "components" collection but also has a parent componentId set, the latter is leading)'
					},
					init: {
						'!type': 'fn()',
						'!doc': 'Initializes the component',
					},
					// events: {
					// 	'!doc': 'Define event handlers for component',
					// 	'!url': 'http://gfk.com'
					// },
					// eventHandlers: {
					// 	'!type': '[]',
					// 	'!doc': 'Define collection of `events`',
					// 	'!url': 'http://gfk.com'
					// },
					removed: {
						'!type': 'bool',
						'!doc': 'a boolean indicating whether the component has been removed'
					},
					editMode: {
						userDefined: 'bool',
						move: 'bool',
						remove: 'bool',
						resize: 'bool',
						add: {
							allow: 'bool',
							thumbnail: 'string',
							description: 'string',
							index: 'number'
						},
						edit: {
							allow: 'bool',
							properties: {
								propertyName: {
									type: 'string',
									label: 'string',
									definition: '',
									translate: 'bool'
								}
							},
							settings: {
								settingName: {
									type: 'string',
									label: 'string',
									definition: '',
									translate: 'bool'
								}
							},
							inputSettings: {
								inputSettingName: {
									type: 'string',
									label: 'string',
									definition: '',
									translate: 'bool'
								}
							}
						}
					}
				},
				Sites: {
					componentLibraries: '[]',
					configuration: '',
					dataRequests: '',
					init: 'fn()',
					libraries: '[]',
					settings: {
						server: 'string',
						theme: 'string',
						color: 'string',
						serverTimezoneOffset: 'number',
						serverTimezone: 'string',
						requestTimeout: 'number',
						applyImageColorMask: 'bool',
						popupCloseButtonImage: 'string',
						googleAnalyticsUA: 'string',
						googleAnalyticsEnabled: 'bool',
						definitionContext: 'string',
						colorScheme: '[]',
						activeLanguages: '',
						dynamicFilters: 'bool'
					},
					supportedLanguages: '',
					translations: ''
				}
			},

			DashboardComponent: {
				properties: {
					elementID: {
						'!type': 'string',
						'!doc': 'ID for this component\'s DOM element.'
					},
					cssClassName: {
						'!type': 'string',
						'!doc': 'Define css class name for DOM element'
					},
					title: {
						'!type': 'string',
						'!doc': ''
					},
					subtitle: {
						'!type': 'string',
						'!doc': ''
					},
					contentHeight: {
						'!type': 'number',
						'!doc': ''
					},
					contentWidth: {
						'!type': 'number',
						'!doc': ''
					},
					width: {
						'!type': 'number',
						'!doc': ''
					},
					height: {
						'!type': 'number',
						'!doc': ''
					},
					style: {
						'!doc': ''
					},
					visible: {
						'!type': 'bool',
						'!doc': ''
					},
					showTitle: {
						'!type': 'bool',
						'!doc': ''
					},
					index: {
						'!type': 'number',
						'!doc': ''
					},
					showIf: {
						'!type': 'fn()',
						'!doc': 'If set, this function will be evaluated each time an update is called on the widget. If its return value is truthy, the widget will be shown. If it is falsy, the widget will be hidden. events <object> eventHandlers <Array>'
					},
					events: {
						'!doc': '',
						click: {
							'!type': 'fn()',
							'!doc': ''
						},
						focus: {
							'!type': 'fn()',
							'!doc': ''
						},
						blur: {
							'!type': 'fn()',
							'!doc': ''
						},
						mouseover: {
							'!type': 'fn()',
							'!doc': ''
						},
						mouseout: {
							'!type': 'fn()',
							'!doc': ''
						},
						mousemove: {
							'!type': 'fn()',
							'!doc': ''
						},
						change: {
							'!type': 'fn()',
							'!doc': ''
						},
						submit: {
							'!type': 'fn()',
							'!doc': ''
						},
						mousedown: {
							'!type': 'fn()',
							'!doc': ''
						},
						mouseup: {
							'!type': 'fn()',
							'!doc': ''
						},
						keypress: {
							'!type': 'fn()',
							'!doc': ''
						},
						keydown: {
							'!type': 'fn()',
							'!doc': ''
						},
						keyup: {
							'!type': 'fn()',
							'!doc': ''
						},
						beforeShow: {
							'!type': 'fn()',
							'!doc': ''
						},
						afterShow: {
							'!type': 'fn()',
							'!doc': ''
						},
						beforeDraw: {
							'!type': 'fn()',
							'!doc': ''
						},
						afterDraw: {
							'!type': 'fn()',
							'!doc': ''
						},
						beforeUpdate: {
							'!type': 'fn()',
							'!doc': ''
						},
						afterUpdate: {
							'!type': 'fn()',
							'!doc': ''
						},
						beforeFetchData: {
							'!type': 'fn()',
							'!doc': ''
						},
					},
					eventHandlers: {
						'!type': '[]',
						'!doc': ''
					},
					editMode: {
						'!doc': 'An object containing editMode options for this component exportOptions <object> hasDownloadButton <bool> hasMailButton <bool>'
					},
					exportOptions: {
						'!doc': ''
					},
					hasDownloadButton: {
						'!doc': ''
					},
					hasMailButton: {
						'!type': 'bool',
						'!doc': ''
					},
					messageListeners: {
						'!type': '[]',
						'!doc': "An array of message handlers of form: {message: '', handler: function () {}}, or an object of form: {message: function () {}, anotherMessage: function () {}, ...}"
					},
					catchableEvents: {
						'!type': '[]',
						'!doc': "'click','focus','blur','mouseover','mouseout','mousemove','change','submit','mousedown','mouseup','keypress',keydown','keyup'"
					}
				},
				defaultSettings: {
					numberFormat: {
						'!type': 'string',
						'!doc': "[numberFormat='continental']"
					},
					decimals: {
						'!type': 'number',
						'!doc': ''
					},
					showTooltip: {
						'!type': 'bool',
						'!doc': ''
					},
					libDir: {
						'!type': 'string',
						'!doc': "[libDir='lib']"
					},
					theme: {
						'!type': 'string',
						'!doc': "[theme='gfk']"
					},
					inputSettingsDefinition: {
						'!doc': ''
					},
					dateFormat: {
						'!type': 'string',
						'!doc': "dateFormat='%d %m %Y'"
					},
					server: {
						'!type': 'string',
						'!doc': ''
					},
					dataServer: {
						'!type': 'string',
						'!doc': "[dataServer='/jsonp.php']"
					},
					exportServer: {
						'!type': 'string',
						'!doc': "[exportServer='/export.php']"
					},
					mailButtonImage: {
						'!type': 'string',
						'!doc': "[mailButtonImage='mail']"
					},
					downloadButtonImage: {
						'!type': 'string',
						'!doc': "[downloadButtonImage='download']"
					},
					editable: {
						'!type': 'bool',
						'!doc': ''
					},
					editMode: {
						'!type': 'bool',
						'!doc': ''
					},
					colorScheme: {
						'!doc': ''
					},
					color: 'string',
					subtitleColored: 'string',
					inputSettings: 'string',
					locale: 'string',
					serverHostname: 'string',
					serverScheme: 'string',
					serverPort: 'string'
				},
				EVENT_CATEGORIES: {
					WIDGET: 'string',
					WIDGET_EDIT: 'string',
					WIDGET_BAR: 'string',
					PAGE_EDIT: 'string',
					FILTER: 'string',
					TRANSLATION: 'string',
					FILE: 'string',
					EDIT_MODE: 'string',
					PACKAGES: 'string',
					NOTIFICATION: 'string',
					BLOCK_EDIT: 'string',
					TABLE: 'string',
					USER_SETTINGS: 'string',
					CHART: 'string',
					PAGE: 'string'
				},
				prototype: {
					'draw': {
						'!type': 'fn(parentNode: ?, before: ?) -> !this.DOMElement',
						'!doc': 'Draws the component within its parent node.\nCreates a HTMLDivElement which functions as the outer node for the component.\nAppends this div element to the parent node.\nIf parentNode is omitted, document.body is used.\n\n@param {HTMLElement} parentNode (Optional) The node to draw itself in.\n@param {HTMLElement} before (Optional) A child element of parentNode before which the component will be inserted.\n\n@returns {HTMLDivElement} The component\'s outer DOM element'
					},
					'setSettings': {
						'!type': 'fn(settings: ?) -> DashboardComponent.parentComponent',
						'!doc': 'Sets several of the component\'s settings at once.\n\n@param {Object} settings A settings object\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'getSettings': {
						'!type': 'fn() -> !this.defaultSettings',
						'!doc': 'Returns a settings object containing all settings for this object.\nThis is a combination of local, inherited and default settings.\n\n@returns {Object} A settings object'
					},
					'setSetting': {
						'!type': 'fn(setting: string, value: ?, markAsModified?: bool) -> !this',
						'!doc': 'Sets a setting to the specified value for this component.\n\n@param {string} setting The setting identifier (name of the setting)\n@param {*} value The value for the setting\n@param {boolean} [markAsModified=false] When true, setting will be marked as modified for editMode purposes\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'getSetting': {
						'!type': 'fn(setting: string) -> ?',
						'!doc': 'Returns the value for one of the component\'s settings.\nIf the setting is not specified for this component, it will look for the setting in the parent component.\nIf none is found there, it will look for a default setting in this component\'s default settings.\nIf none is found there either, undefined is returned.\n\n@param {string} setting Setting identifier (name of the setting)\n\n@returns {*} The value of the specified setting or undefined if not found'
					},
					'getElementId': {
						'!type': 'fn() -> !this.elementID',
						'!doc': 'Returns the component\'s element ID\n\n@returns {string} The component\'s element ID'
					},
					'setColor': {
						'!type': 'fn(color: ?, green: number, blue: number, opacity: ?) -> !this',
						'!doc': 'Sets the component\'s base color.\nAccepts one of three different formats:\n- A Color object.\n- A string containing a color in HTML notation (either \'rgb(255, 255, 255)\' or \'#FFFFFF\' or \'#fff\')\n- Three bytes indicating the red, green and blue value of the color and optionally a value from 0 to 1 for the opacity.\n\n@param {mixed} color A Color object, HTML color string or a number from 0 to 255 indicating the red value\n@param {number} green Optional. A number from 0 to 255 indicating the green value\n@param {number} blue Optional. A number from 0 to 255 indicating the blue value\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'getColor': {
						'!type': 'fn() -> ?',
						'!doc': 'Returns this component\'s color object\n\n@returns {Color} A Color object'
					},
					'setRgbColor': {
						'!type': 'fn(red: number, green: number, blue: number) -> !this',
						'!doc': 'Sets this component\'s color in R,G,B format\n\n@param {number} red A value from 0 to 255 indicating the color\'s red value\n@param {number} green A value from 0 to 255 indicating the color\'s green value\n@param {number} blue A value from 0 to 255 indicating the color\'s blue value\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'setHtmlColor': {
						'!type': 'fn(htmlColor: string) -> !this',
						'!doc': 'Sets this component\'s color in HTML format (#rrggbb, #rgb, rgb(r, g, b))\n\n@param {string} htmlColor An html color in hexidecimal format, optionally preceded by a #, or in decimal format using rgb()\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'getHtmlColor': {
						'!type': 'fn() -> string',
						'!doc': 'Gets the html color setting\n\n@returns {string} HTML color string, e.g.: #123abc'
					},
					'getTitle': {
						'!type': 'fn() -> !this.title',
						'!doc': 'Returns the title\n\n@returns {string} This component\'s title'
					},
					'setTitle': {
						'!type': 'fn(title: string) -> !this',
						'!doc': 'Sets the title of the component and displays it in the appropriate element\nif it exists.\n\n@param {string} title The title for the component, does not accept html characters or markup; plain text only. Use \\u unicode characters for special characters.\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'setSubtitle': {
						'!type': 'fn(subtitle: string) -> !this',
						'!doc': 'Sets the subtitle of the component and displays it in the appropriate\nelement if it exists.\n\n@param {string} subtitle The subtitle for the component, accepts html characters and markup.\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'getSubtitle': {
						'!type': 'fn() -> !this.subtitle',
						'!doc': 'Returns the subtitle\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'setWidth': {
						'!type': 'fn(width: number) -> !this',
						'!doc': 'Sets this component\'s width in pixels\n\n@param {number} width The width in pixels\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'setHeight': {
						'!type': 'fn(height: ?) -> !this',
						'!doc': 'Sets this component\'s height in pixels\n\n@param {number} width The height in pixels\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'getWidth': {
						'!type': 'fn() -> !this.width',
						'!doc': 'Returns the component\'s width\n\n@returns {number} The width'
					},
					'getHeight': {
						'!type': 'fn() -> !this.height',
						'!doc': 'Returns the component\'s width\n\n@returns {number} The height'
					},
					'setContentWidth': {
						'!type': 'fn(width: number) -> !this',
						'!doc': 'Sets the width of the content element of this component, which is its body excluding header, footer, etc.\n\n@param {number} width The content width in pixels\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'setContentHeight': {
						'!type': 'fn(height: number) -> !this',
						'!doc': 'Sets the height of the content element of this component, which is its body excluding header, footer, etc.\n\n@param {number} height The content height in pixels\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'getContentWidth': {
						'!type': 'fn() -> !this.contentWidth',
						'!doc': 'Returns this component\'s content width\n\n@returns {number} The content width'
					},
					'getContentHeight': {
						'!type': 'fn() -> !this.contentHeight',
						'!doc': 'Returns this component\'s content height\n\n@returns {number} The content height'
					},
					'setSubtitleColored': {
						'!type': 'fn(subtitleColored: bool) -> !this',
						'!doc': 'Setting to indicate whether the subtitle needs to be colored\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object\n@deprecated'
					},
					'applyDimensions': {
						'!type': 'fn(element?: ?) -> !this',
						'!doc': 'Applies the component\'s width and height\n\n@param {DOMElement} [element= this.DOMElement] The element to apply the dimensions to.If omitted, the DOMElement property is used.\n\n @returns {_DP.ComponentTypes.DashboardComponent} This object '
					},
					'getColorScheme': {
						'!type': 'fn(preserveIndex: bool) -> ?',
						'!doc': 'Returns the component\'s colorscheme object\n\n@param {boolean} preserveIndex Specifies whether the color scheme\'s index should be preserved (by default, it start from the first color in the scheme). False if omitted.\n\n@returns {ColorScheme} The component\'s colorscheme object'
					},
					'setColorScheme': {
						'!type': 'fn(colorScheme: ?) -> !this',
						'!doc': '@param {ColorScheme} colorScheme The color scheme to use\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'setTheme': {
						'!type': 'fn(themeName: string) -> !this',
						'!doc': '@param {string} themeName The name of the theme to use\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'getTheme': {
						'!type': 'fn() -> string',
						'!doc': 'Returns the name of the theme\n\n@returns {string}'
					},
					'setInputSettings': {
						'!type': 'fn(inputSettings: DashboardComponent.prototype.setInputSettings.!0)',
						'!doc': 'Merges received input settings object with already existing input settings\nand sets this as the new input settings\n\n@param {Object} inputSettings Object containing new input settings\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'getInputSettings': {
						'!type': 'fn() -> ?',
						'!doc': 'Returns the input settings\n\n@returns {Object} The input settings'
					},
					'setDashboard': {
						'!type': 'fn(dashboard: ?) -> !this',
						'!doc': 'Sets a reference to the dashboard this component belongs to\n\n@param {_DP.ComponentTypes.Dashboard} dashboard A reference to a Dashboard object\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'getDashboard': {
						'!type': 'fn() -> !this.dashboard',
						'!doc': 'Returns a reference to the dashboard this component belongs to\n\n@returns {_DP.ComponentTypes.Dashboard} This component\'s dashboard'
					},
					'setParentComponent': {
						'!type': 'fn(component: DashboardComponent.parentComponent) -> !this',
						'!doc': 'Sets a reference to this component\'s parent component\n\n@param {_DP.ComponentTypes.DashboardComponent} component A reference to a parent component\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'getParentComponent': {
						'!type': 'fn() -> !this.parentComponent',
						'!doc': 'Returns a reference to this component\'s parent component\n\n@returns {_DP.ComponentTypes.DashboardComponent} This component\'s parent component'
					},
					'addCssClass': {
						'!type': 'fn(cssClassName: string) -> !this',
						'!doc': 'Adds a CSS class to this component\'s DOM element\n\n@param {string} cssClassName The class to add\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'removeCssClass': {
						'!type': 'fn(cssClassName: string) -> !this',
						'!doc': 'Removes a CSS class from this component\'s DOM element\n\n@param {string} cssClassName The CSS class to remove\n\n@returns {_DP.ComponentTypes.DashboardComponent}'
					},
					'setNumberFormat': {
						'!type': 'fn(format: string, decimals: number) -> !this',
						'!doc': 'Sets the number format, Deprecated use setSetting(\'numberFormat\') and setSetting(\'decimals\') instead\n\n@deprecated\n\n@param {string} format Current possible formats: \'continental\' (default): 2.034,76 \'continental2\': 2034,76 \'english\': 2,034.76 \'english2\': 2034.76 \'french\': 2 034,76\n@param {number} decimals Number of digits\n\n@returns {_DP.ComponentTypes.DashboardComponent} this object'
					},
					'getNumberFormat': {
						'!type': 'fn() -> string',
						'!doc': 'Gets the number format, Deprecated use getSetting(\'numberFormat\') instead\n\n@deprecated\n\n@returns {string} Number format on Dashboard level'
					},
					'setDecimals': {
						'!type': 'fn(decimals: number) -> DashboardComponent.parentComponent',
						'!doc': 'Sets the decimals setting, Deprecated Use setSetting(\'decimals\') instead\n\n@deprecated\n\n@param {number} decimals Number of digits\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'getDecimals': {
						'!type': 'fn() -> number',
						'!doc': 'Returns the number of decimals to which numbers displayed by this component are rounded,\nDeprecated use getSetting(\'decimals\') instead\n\n@deprecated\n\n@returns {number} The number of decimals'
					},
					'formatNumber': {
						'!type': 'fn(number: number, decimals: number, useShortHand: bool, shortHandPrecision: ?) -> string',
						'!doc': 'Calls NumberFormatter.formatNumber\n\n@param {number} number The number to format\n@param {number} decimals Optional, if not given then it\'s retrieved from Settings.\n@param {boolean} useShortHand If true, numbers above 1000 will be shortened to ##k and numbers above 1 million will be shortened to ##M. Numbers not shown are truncated (rounded down).\n\n@returns {string} formatted number'
					},
					'formatDate': {
						'!type': 'fn(timestamp: ?, format: string, useUTC: ?) -> string',
						'!doc': 'Formats a timestamp as a date according to this component\'s locale and the\nspecified format.\nIf a format is not specified, the component\'s dateFormat setting is used.\n\n@param {numeric} timestamp A UNIX timestamp\n@param {string} format (Optional) A dateformat string\n\n@returns {string} A formatted date'
					},
					'setOnClick': {
						'!type': 'fn(action: ?) -> !this',
						'!doc': 'Sets the OnClick event for this component\nDeprecated. Use addEventHandler.\n\n@deprecated\n\n@param {}  action <function>,<string> - The action of the event\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'setOnChange': {
						'!type': 'fn(action: ?) -> !this',
						'!doc': 'Sets the onchange event handler\nDeprecated. Use addEventHandler.\n\n@deprecated\n\n@param {}  action <function>,<string> - The action of the event\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'setOnMouseOver': {
						'!type': 'fn(action: ?) -> !this',
						'!doc': 'Sets the onmouseover event handler\nDeprecated. Use addEventHandler.\n\n@deprecated\n\n@param {}  action <function>,<string> - The action of the event\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'setOnMouseMove': {
						'!type': 'fn(action: fn(e: ?)) -> !this',
						'!doc': 'Sets the onmousemove event handler\nDeprecated. Use addEventHandler.\n\n@deprecated\n\n@param {}  action <function>,<string> - The action of the event\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'setOnMouseOut': {
						'!type': 'fn(action: fn(e: ?)) -> !this',
						'!doc': 'Sets the onmouseout event handler\nDeprecated. Use addEventHandler.\n\n@deprecated\n\n@param {}  action <function>,<string> - The action of the event\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'setEventHandler': {
						'!type': 'fn(event: string, action: ?) -> !this',
						'!doc': 'Sets the event handler for the specified event\nDeprecated. Use addEventHandler.\n\n@param {string} event The name of the event (click, change, mouseover, etc.) action <function>,<string> - The action of the event\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'copy': {
						'!type': 'fn() -> DashboardComponent.prototype.copy.!ret',
						'!doc': 'creates an exact copy of the dashboardComponent\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'setLocale': {
						'!type': 'fn(locale: ?) -> !this',
						'!doc': 'Sets the locale setting.\nDeprecated, use setSetting(\'locale\')\n\n@deprecated\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'getLocale': {
						'!type': 'fn() -> string',
						'!doc': 'Gets the locale setting.\n\n@returns {string} The locale setting'
					},
					'setTooltip': {
						'!type': 'fn(tooltip: ?) -> !this',
						'!doc': 'Set the tooltip\n\n@param {_DP.ComponentTypes.Tooltip} tooltip The tooltip to be set'
					},
					'getTooltip': {
						'!type': 'fn() -> !this.tooltip',
						'!doc': 'Get the tooltip\nReturns\n<Tooltip> The Tooltip of the dashboardComponent'
					},
					'setShowTooltip': {
						'!type': 'fn(bool: bool) -> !this',
						'!doc': 'Set the showToolTip setting\nDeprecated use setSetting(\'showToolTip\') instead\nReturns\n<DashboardComponent> This object\n\n@deprecated'
					},
					'getShowTooltip': {
						'!type': 'fn() -> ?',
						'!doc': 'Get the showToolTip setting\nDeprecated use getSetting(\'showToolTip\') instead\nReturns\n<bool> The showToolTip setting\n\n@deprecated'
					},
					'getLibDir': {
						'!type': 'fn() -> ?',
						'!doc': 'Get the libDir setting\nReturns\n<String> The libDir setting'
					},
					'setLibDir': {
						'!type': 'fn(libDir: ?) -> !this',
						'!doc': 'Sets the libDir setting\n\nReturns\n<DashboardComponent> This object'
					},
					'setInputSettingsDefinition': {
						'!type': 'fn(inputSettingsDefinition: ?) -> !this',
						'!doc': 'Sets the definition of the inputsettings returned by this component.\nIn it, each input setting is defined and linked to a parameter for the data request.\nFormat:\n{\ninputsetting: {\nuseFilterString: <boolean> Whether it should be passed as part of the filterstring or as a request parameter.\nvariable:        <string>  Name of the variable (filterstring) or name of the data request parameter (non-filterstring).\nmulti:           <boolean> Whether the inputsetting can have multiple values.\noperator:        <string>  Boolean operator that determines how multiple values are combined (multi filterstring only). Legal operators: OR, AND. Defaults to OR.\n}\n}\n\n@param {Object} inputSettingsDefinition An object containing the inputsettings definition\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'setInputSettingDefinition': {
						'!type': 'fn(inputSetting: string, definition: ?) -> !this',
						'!doc': 'Sets or adds the definition of one inputsetting.\nIn it, an input setting is defined and linked to a parameter for the data request.\nFormat:\n{\nuseFilterString: <boolean> Whether it should be passed as part of the filterstring or as a request parameter.\nvariable:        <string>  Name of the variable (filterstring) or name of the data request parameter (non-filterstring).\nmulti:           <boolean> Whether the inputsetting can have multiple values.\noperator:        <string>  Boolean operator that determines how multiple values are combined (multi filterstring only). Legal operators: OR, AND. Defaults to OR.\n}\n\n@param {string} inputSetting The name of the inputsetting\n@param {object} definition An object containing the inputsetting definition\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'getInputSettingsDefinition': {
						'!type': 'fn() -> ?',
						'!doc': 'Returns the inputsettings definition for this component.\n\n@returns {object} An inputsettings definition object. For format, see setInputSettingsDefinition.'
					},
					'getInputSettingDefinition': {
						'!type': 'fn(name: string) -> ?',
						'!doc': 'Returns the definition of a single inputsetting for this component.\n\n@param {string} name The name of the inputsetting for which the definition will be returned.\n\n@returns {object} An inputsetting definition object. For format, see setInputSettingsDefinition.'
					},
					'removeInputSettingDefinition': {
						'!type': 'fn(name: string) -> !this',
						'!doc': 'Removes an inputSetting\'s definition and the inputSetting itself\n\n@param {string} name The name of the inputSetting to remove\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'update': {
						'!type': 'fn(inputSettings?: ?) -> !this',
						'!doc': 'Abstract. Each component needs to have an update method required for\ninteraction through the inputWidgets. Should be overwritten by specific\nclasses.\nComponents containing other components should pass the update call on to\ntheir children.\nComponents that need to refresh their data or contents based on the new\ninputSettings should do so.\n\n@param {object} [inputSettings] An inputSettings object\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'setDateFormat': {
						'!type': 'fn(format: string) -> !this',
						'!doc': 'Sets the dateFormat setting\nDeprecated use setSetting(\'dateFormat\') instead.\n\n@deprecated\n\n@param {string} format The dateformat setting\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'getDateFormat': {
						'!type': 'fn() -> string',
						'!doc': 'Get the dateFormat setting\nDeprecated use setSetting(\'dateFormat\') instead.\n\n@returns {string} The dateFormat setting'
					},
					'setServer': {
						'!type': 'fn(url: string) -> !this',
						'!doc': 'Set the server setting\nDeprecated use setSetting(\'server\') instead.\n\n@deprecated\n\n@param {string} url The url setting\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'getServer': {
						'!type': 'fn() -> string',
						'!doc': 'Gets the current server\n\n@returns {string} The adres of the server'
					},
					'getExportServer': {
						'!type': 'fn() -> string',
						'!doc': 'Gets the current export server\n\n@returns {string} The adres of the export server'
					},
					'getDataServer': {
						'!type': 'fn() -> string',
						'!doc': 'Gets the current data server\n\n@returns {string} The adres of the server'
					},
					'getServerHostname': {
						'!type': 'fn() -> string',
						'!doc': 'Gets the hostname of the server\n\n@returns {string} The hostname of the server'
					},
					'getServerScheme': {
						'!type': 'fn() -> string',
						'!doc': 'Gets the scheme of the server\n\n@returns {string} scheme of the server'
					},
					'getServerPort': {
						'!type': 'fn() -> string',
						'!doc': 'Gets the port of the server\n\n@returns {string} The port of the server'
					},
					'addEventHandler': {
						'!type': 'fn(event: string, handler: ?, context?: ?) -> !this',
						'!doc': 'Add a event handler\n\n@param {string} event The event to add a handler too\n@param {function} handler The function that handles the event\n@param {object} [context=this] The context to be given to the handler\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'disableEvent': {
						'!type': 'fn(event: string) -> !this',
						'!doc': 'disables a event\n\n@param {string} event The event to disable\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'enableEvent': {
						'!type': 'fn(event: string) -> !this',
						'!doc': 'disables a event\n\n@param {string} event The event to enable\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'setStyle': {
						'!type': 'fn(style: ?) -> !this',
						'!doc': 'Sets the style of the DOMElement of the dashboardcompnent\n\n@param {object} style The style object\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'getStyle': {
						'!type': 'fn() -> !this.style',
						'!doc': 'Gets the style of the dashboardcompnent\n\n@returns {object} The style object'
					},
					'translate': {
						'!type': 'fn(string: string, args?: ?) -> string',
						'!doc': 'Translates a language string, using _DP.Language and the\ntranslations in _DP.Language.Translations.\nThe language to use is determined by the \'locale\' settings.\nThe string can contain placeholders of the format {%label%}, where \'label\'\nshould appear as a property in the args object and the placeholder will be\nreplaced by the value of the property \'label\'.\n\n@param {string} string The string to translate\n@param {object} [args] An associative array, containing labels of placeholders and their values\n\n@returns {string} The translated string'
					},
					'undraw': {
						'!type': 'fn() -> !this',
						'!doc': 'Undraws the component\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'setVisible': {
						'!type': 'fn(visible: bool) -> !this',
						'!doc': 'Sets the visibility of the component.\nDeprecated use toggle instead.\n\n@deprecated\n\n@param {boolean} visible\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'show': {
						'!type': 'fn(parentNode?: ?) -> !this',
						'!doc': 'Shows the component\n\n@param {HTMLElement} [parentNode=this.getParentComponent()] The node to which the component must be attached\n*\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'hide': {
						'!type': 'fn() -> !this',
						'!doc': 'Hides the component\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'getComponent': {
						'!type': 'fn(component: string) -> !0',
						'!doc': 'Gets a component\n\n@param {string} component The id of the component\n\n@returns {object} The component'
					},
					'addExportButtons': {
						'!type': 'fn() -> !this',
						'!doc': 'Adds the buttons for mailing and downloading the component.\n\n@protected\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'disableExportButtons': {
						'!type': 'fn() -> !this',
						'!doc': 'Disables the buttons for mailing and downloading the component.\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'enableExportButtons': {
						'!type': 'fn() -> !this',
						'!doc': 'Enables the buttons for mailing and downloading the component.\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'fireEvent': {
						'!type': 'fn(event: string, args: [?]) -> +DashboardComponent',
						'!doc': 'Fires a given event\n\n@param {}  event <string> the event to fire args <array> The arguments to give to the handler of the event\n\n@returns {} handleEvent'
					},
					'add': {
						'!type': 'fn(component: DashboardComponent.downloadButton, markAsModified?: bool) -> !this',
						'!doc': 'Add a component to the children of the component\n\n@param {_DP.ComponentTypes.DashboardComponent} component The component to add\n@param {boolean} [markAsModified=false] Whether to mark the component as added for editMode purposes\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'getComponentById': {
						'!type': 'fn(componentId: string) -> !this.children.<i>',
						'!doc': 'Get a child component by it\'s id\n\n@param {string} componentId the event to fire\n\n@returns {object} The child component'
					},
					'getComponentByLibraryId': {
						'!type': 'fn(libraryComponentId: string) -> ?',
						'!doc': 'Get a child component by it\'s libraryComponentId\n\n@param {string} libraryComponentId The librarycomponentid of the to be found component\n\n@returns {object} The child component'
					},
					'getComponentByCoreComponentId': {
						'!type': 'fn(coreComponentId: string) -> ?',
						'!doc': 'Get a child component by it\'s coreComponentId\n\n@param {string} coreComponentId The coreComponentId of the to be found component\n\n@returns {object} The child component'
					},
					'setPage': {
						'!type': 'fn(page: ?) -> !this',
						'!doc': 'Sets the page of the DashboardComponent\n\n@param {Page} page The page to which the component should be added\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'getPage': {
						'!type': 'fn() -> !this.page',
						'!doc': 'Gets the page of the DashboardComponent\n\n@returns {Page} The page to which the component belongs'
					},
					'move': {
						'!type': 'fn(parentNode: ?, before: ?) -> +DashboardComponent',
						'!doc': 'Move the component to another parentNode\n\n@param {}  parentnode <DOM Object> - The node to which the component must be moved before <DOM Object> (optional) - The node before which the component must be moved'
					},
					'setParentNode': {
						'!type': 'fn(parentNode: ?) -> !this',
						'!doc': 'Sets the parentNode of the component and appends the component to that parentNode\n\n@param {}  parentnode <DOM Object> - The node to which the component must be moved\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'detach': {
						'!type': 'fn() -> !this',
						'!doc': 'Detaches the component from it\'s parentNode and sets parentNode to null\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'attach': {
						'!type': 'fn(parentNode: ?, before: ?) -> !this',
						'!doc': 'Attach the component to the given parentNode.\n\n@param {}  parentnode <DOM Object> - The node to which the component must be moved before <DOM Object> (optional) - The node before which the component must be moved\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'clearInputSettings': {
						'!type': 'fn(settings?: [?], preventUpdate?: bool) -> !this',
						'!doc': 'Clears the given inputsettings and updates the component if necessary\n\n@param {Array} [settings] The settings to clear\n@param {boolean} [preventUpdate=false] If true, no update will be called on this component after clearing the inputsettings\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'getHostName': {
						'!type': 'fn() -> string',
						'!doc': 'Returns the hostname of the current browser window\n\n@returns {string} The hostname'
					},
					'formatName': {
						'!type': 'fn(firstname: ?, middlename: ?, lastname: ?, format: ?) -> string',
						'!doc': 'Formats a firstname, middlename and lastname into a fullname according to\nthe specified format or the nameFormat setting.\n\n@param {}  firstname <string> (Optional) The first name middlename <string> (Optional) The middle name lastname <string> (Optional) The last name format <string> (Optional) The format to use. If omitted, the nameFormat setting is used.\n\n@returns {string} A formatted fullname'
					},
					'setInputSettingValue': {
						'!type': 'fn(inputSetting: string, value: ?, markAsModified?: bool) -> !this',
						'!doc': 'Sets the value of a single inputsetting.\n\n@param {string} inputSetting The name of the inputsetting value\n@param {string|number|boolean|object|undefined} value The new value for the inputSetting. If the inputSetting can have multiple values, but a non-Array value is supplied, it will be added instead of set\n@param {boolean} [markAsModified=false] When true, the inputSetting will be marked as modified for editMode purposes\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'getInputSettingValue': {
						'!type': 'fn(inputSetting: ?) -> [?]',
						'!doc': 'Returns the value of a single inputsetting.\n\n@param {}  inputSetting <string> The name of the inputsetting\n\n@returns {mixed} The value (or array of values) of the inputsetting, or undefined if the inputsetting was not set on this component'
					},
					'submitExportRequest': {
						'!type': 'fn(data: ?, inputType: ?, outputType: ?, filename: ?, action: ?, options: ?) -> !this',
						'!doc': 'Submits a export request\n\n@param {}  data <string> The data to use for the export request inputType <string> The inputType of the exportRequest outputType <string> The outputType of the exportRequest filename <string> The filename for the exportRequest action <string> The action of the exportRequest options <object> Extra options to pass in the exportRequest\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'trackEvent': {
						'!type': 'fn(action: string, label: string, value?: number, category?: string|number) -> !this',
						'!doc': 'Tracks an event to Google Analytics and to TrackJS\n\n@param {string} action The event action to add to google analytics\n@param {string} label The event label\n@param {number} [value] The value of the event in case of a number, the category if no fourth argument is provided and the last one provided is a string\n@param {string} [category=\'Portal\'] The event category\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'convertEventHandlers': {
						'!type': 'fn() -> !this',
						'!doc': 'Converts handlers from old format to new\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'createBlurLayer': {
						'!type': 'fn() -> !this',
						'!doc': 'Creates the blur layer element of the component\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'blur': {
						'!type': 'fn() -> !this',
						'!doc': 'Blurs the current component\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'unblur': {
						'!type': 'fn() -> !this',
						'!doc': 'unBlurs the current component\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'getExportOptions': {
						'!type': 'fn() -> [?]',
						'!doc': 'Returns the exportOptions of the component\n\n@returns {array} The exportOptions'
					},
					'removeCatchableEvent': {
						'!type': 'fn(event: string) -> !this',
						'!doc': 'Removes a catchableEvent\n\n@param {string} event The event to remove\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'addCatchableEvent': {
						'!type': 'fn(event: string) -> !this',
						'!doc': 'Adds a catchableEvent\n\n@param {string} event The event to add\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'isVisible': {
						'!type': 'fn() -> !this.visible',
						'!doc': 'Returns if the component is visible\n\n@returns {bool} The visibility of the component'
					},
					'getComponents': {
						'!type': 'fn() -> !this.components',
						'!doc': 'Returns an array containing all child components of this component.\n\n@returns {Array} An array of DashboardComponents.'
					},
					'getDefinition': {
						'!type': 'fn(options?: ?) -> ?|DashboardComponent.prototype.getDefinition.!ret',
						'!doc': 'Generates and returns the JSON definition of this component.\n\nPreconditions:\nThe component should have been instanced by the Engine, so that this.definition is set.\nthis.editMode.exclude should be falsy.\n\nPostconditions:\nNone\n\n@param {object} [options={}]\n@config {boolean} modifiedOnly Returns only the changes in the definition compared to the component\'s static definition.\n@config {string} context The name of the custom context for which to generate the definition, can be Portal, Client, Survey or User. Only applicable if modifiedOnly is true.\n@config {boolean} recursive Recursively calls itself on the component\'s children, returning the combined definition of this component and its children.\n@config {boolean} flat Returns the definition as a collection of component definitions in flat-form (non-hierarchical).\n@config {boolean} editableOnly Skips components that aren\'t editable (editable setting is falsy), but still continues processing its children if recursive is true.\n\n@returns {object} The JSON definition of this component.'
					},
					'setProperty': {
						'!type': 'fn(prop: string, value: bool|number, force?: bool) -> !this',
						'!doc': 'Sets a propery value if the new value differs from the current value.\nAlso marks the property as modified if editing is allowed for this component, or the force argument is true.\nUsed by editMode to mark changes to the component\'s properties made by the user.\n\n@param {string} prop The name of the property to change\n@param {*} value The new value\n@param {boolean} [force=false] If true, the modification will be recorded, regardless of whether editing is allowed.\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'remove': {
						'!type': 'fn(component: DashboardComponent.downloadButton, markAsModified?: bool) -> !this',
						'!doc': 'Removes a child component from this component.\n\nPreconditions:\nComponent passed in should be a child of this component.\n\nPostconditions:\nComponents collection of this component will no longer contain the passed in component.\nIf in editMode, this component will have its modified flag set to true.\nIf the child component was part of addedComponents (added during this editMode session), it will be removed from there as well.\n\n@param {_DP.ComponentTypes.DashboardComponent} component The child component to remove\n@param {boolean} [markAsModified=false] Whether to mark the component as removed for editMode purposes\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'clear': {
						'!type': 'fn() -> !this',
						'!doc': 'Removes the children components of the current component.\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'toggleEditMode': {
						'!type': 'fn(enabled: bool) -> !this',
						'!doc': 'Toggles the editMode of the component\n\n@param {boolean} enabled\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'isReady': {
						'!type': 'fn() -> bool',
						'!doc': 'Checks if the component isReady meaning its not calling, fetching or drawin and is visible and drawn.\nIf the component is ready it checks its children.\n\n@returns {bool} Component and it\'s children isReady true or false'
					},
					'getChildren': {
						'!type': 'fn() -> [DashboardComponent.downloadButton]',
						'!doc': 'Gets the children of the component\n\n@returns {Array} A array with the child components'
					},
					'setModified': {
						'!type': 'fn(modified: bool) -> !this',
						'!doc': 'Sets the modified flag, When false clears the addComponents and modifiedProperties\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'redraw': {
						'!type': 'fn() -> !this',
						'!doc': 'Redraws the current component and fires the appropriate events\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'toggle': {
						'!type': 'fn(show?: bool) -> !this',
						'!doc': 'Toggles the visibility of the component\n\n@param {bool} [show=undefined] (optional) force visible to true or false\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'allowEdit': {
						'!type': 'fn() -> bool',
						'!doc': 'Checks if the components allows editing\n\n@returns {bool} Whether editing is allowed'
					},
					'adopt': {
						'!type': 'fn(component: DashboardComponent.parentComponent) -> !this',
						'!doc': 'Adopts a component: removes it from its current parent and adds it as its own child component.\nIf the component is already a child of this component, nothing happens.\n\n@param {_DP.ComponentTypes.DashboardComponent} component The component to adopt\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'canUpdate': {
						'!type': 'fn() -> !this.isDrawn',
						'!doc': 'Checks if the component can be updated\n\n@returns {bool}'
					},
					'addCoreComponent': {
						'!type': 'fn(coreComponentId: string) -> DashboardComponent.parentComponent',
						'!doc': 'Creates a new component based on the coreComponent definition with the specified ID, adds it as a child to the\ncurrent component.\n\n@param {string} coreComponentId The ID of the coreComponent definition to use\n\n@returns {_DP.ComponentTypes.DashboardComponent} The created component'
					},
					'addCoreComponents': {
						'!type': 'fn() -> [?]',
						'!doc': 'Creates and adds one or more new components from definitions in _DP.Definition.Core.\n\n@param {...string} var_args Any number of strings describing core components (IDs)\n\n@returns {Array} An array containing all core components created and added to the component.'
					},
					'getNextSibling': {
						'!type': 'fn() -> DashboardComponent.parentComponent',
						'!doc': 'Gets the next sibling of the parent component.\n\n@returns {_DP.ComponentTypes.DashboardComponent} The next sibling of the parent component'
					},
					'getPreviousSibling': {
						'!type': 'fn() -> DashboardComponent.parentComponent',
						'!doc': 'Gets the previous sibling of the parent component.\n\n@returns {_DP.ComponentTypes.DashboardComponent} The previous sibling of the parent component'
					},
					'showNotification': {
						'!type': 'fn(options: ?) -> !this',
						'!doc': 'Shows a notification\n\n@param {}  options <object> the options to pass to the notification see Dashboard.showNotification\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'isModified': {
						'!type': 'fn() -> !this.modified',
						'!doc': 'Returns whether the component or it\'s children have been modified\n\n@returns {bool}'
					},
					'getComponentType': {
						'!type': 'fn() -> !this._componentType',
						'!doc': 'Returns the type of the component\n\n@returns {string} the component type'
					},
					'isInColumn': {
						'!type': 'fn(columnIndices: [?|number]|number) -> bool',
						'!doc': 'Checks if the component is in (one of) the given column/s\n\n@param {Array|number}  columnIndices The column/s to check\n\n@returns {bool}'
					},
					'publishMessage': {
						'!type': 'fn(message: string, args?: [?]) -> !this',
						'!doc': 'Emits a global message\n\n@param {string} message The message\n@param {Array} [args] An array of arguments that will be passed to the subscribers\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'subscribe': {
						'!type': 'fn(message: string, handler: ?) -> !this',
						'!doc': 'Adds a new message listener\n\n@param {string} message The message\n@param {function} handler The function to be executed when the specified message is received\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'fitToParent': {
						'!type': 'fn() -> !this',
						'!doc': 'Fits the widget inside its parent component\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'setColumnIndex': {
						'!type': 'fn(columnIndex: number) -> !this',
						'!doc': 'Sets the component\'s column index (in which column of its parent container it should be drawn).\nDefault is 0 (zero), which indicates the first column.\n\n@param {number} columnIndex Column index\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'getColumnIndex': {
						'!type': 'fn() -> !this.columnIndex',
						'!doc': 'Returns the component\'s column index (in which column of its parent container it should be drawn).\nDefault is 0 (zero), which indicates the first column.\n\n@returns {number} Column index'
					},
					'setContainer': {
						'!type': 'fn(container: ?) -> !this',
						'!doc': 'Sets a reference to the container this component belongs to\n\n@param {_DP.ComponentTypes.Container} container A reference to a Container object\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'orderComponents': {
						'!type': 'fn(components?: [?]) -> !this',
						'!doc': 'Assigns an index to each of the child components according to their position in the DOM\n\n@param {Array} [components] The components that should be ordered. Defaults to all child components.\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'startDrag': {
						'!type': 'fn(e: ?) -> bool',
						'!doc': 'Handler for the mousedown event on the components\'s edit bar that starts dragging mode\n\n@protected\n\n@param {Event} e The Event object\n\n@returns {bool} False if mousebutton 1 was clicked and the drag was initiated, true otherwise, so that the event is propagated to the next handler'
					},
					'drag': {
						'!type': 'fn(e: ?) -> bool',
						'!doc': 'Handler for the mousemove event when in dragging mode that repositions the component according to the mouse delta\n\n@protected\n\n@todo The current solution to determine the dragTarget is imperfect. It allows us to regard the space in between\nwidgets inside a column, or containers inside a page, as the page, which causes the placeholder to be placed at the\nbottom of the column/page.\nIn practice, this means that in order to drag a container inside a column, you have to approach the column from the\nbottom. Approaching it from the top will cause the page to receive the dragTarget first, which then places the\nplaceholder at the bottom of the page, moving the target column up.\nA better solution would be to create a div that functions as a droptarget proxy for the column/page at the bottom\nof the column/page, and disallow the actual page/column as a dragTarget.\n\n@param {Event} e The Event object\n\n@returns {bool} False if in dragging mode and mousebutton 1 is being pressed,  true otherwise, so that the event is propagated to the next handler'
					},
					'stopDrag': {
						'!type': 'fn(e: ?) -> bool',
						'!doc': 'Handler for the mouseup event when in dragging mode that ends dragging\n\n@protected\n\n@param {Event} e The Event object\n\n@returns {bool} False if mousebutton 1 was released and dragging mode was ended, true otherwise, so that the event is propagated to the next handler'
					},
					'createDragPlaceholder': {
						'!type': 'fn() -> !this',
						'!doc': 'Creates a placeholder for an object that is going to be dragged\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'removeDragPlaceholder': {
						'!type': 'fn() -> !this',
						'!doc': 'Removes a placeholder created for an object which is going to be dragged\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'showSettingsPopup': {
						'!type': 'fn() -> !this',
						'!doc': 'Shows the settings popup for this component, containing the editMode features\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'toggleCssClass': {
						'!type': 'fn(cssClassName: string, add: bool) -> !this',
						'!doc': 'Adds or removes a CSS class to or from this component\'s DOM element/CSS class list\n\n@param {string} cssClassName The class to add or remove\n@param {boolean} add Whether to add or remove the class\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'addCssClassName': 'DashboardComponent.prototype.addCssClass'
				}
			},

			Widget: {
				'!proto': 'DashboardComponent',
				'!doc': 'The base class for all widgets',
				properties: {
					hasHeader: {
						'!type': 'bool',
						'!doc': 'Specifies if the widget should draw a header. Defaults to false.'
					},
					dummyImagePath: {
						'!type': 'string',
						'!doc': 'Specifies a path to an image which if set will be used to represent the widget instead of its actual content.'
					},
					columnIndex: {
						'!type': 'number',
						'!doc': 'Index of the column of the parent container in which the widget will be drawn. Defaults to 0 (the first column).'
					},
					size: {
						'!type': 'string',
						'!doc': 'Can be one of the constants under _DP.ComponentTypes.Widget: SMALL, MEDIUM, LARGE. Will add a class to the widget\'s DOM element which can be used for size-specific styling.',
						'!data': 'Widget.SIZE'
					},
					bodyStyle: {
						'!doc': 'A style object which will be applied to the widget\'s body.'
					},
					position: {
						'!type': 'string',
						'!doc': 'Can be one of the constants under Widget.POSITION: HEADER, BODY, FOOTER, BUTTONGROUP. Determined into which part of its parent container the widget will be drawn. Defaults to BODY.',
						'!data': 'Widget.POSITION'
					},
					enabled: {
						'!type': 'bool',
						'!doc': 'Specifies whether the widget is enabled (responds to interaction). Defaults to true.'
					},
					updateWhenInvisible: {
						'!type': 'bool',
						'!doc': 'Specifies if the widget should still fetch and process data when it is not visible. Defaults to false.'
					},
					pivotExportData: {
						'!type': 'bool',
						'!doc': 'Specifies whether the widget\'s data should be pivoted (x and y-axes switched) when it is exported to a file. Defaults to false.'
					},
					exportColumnWidth: {
						'!type': 'number',
						'!doc': 'Specifies the width of the columns in the export file. Defaults to 0 (auto).'
					},
					allowExport: {
						'!type': 'bool',
						'!doc': 'Whether the widget\'s data should be included in the exported data when an export is called on a parent component. Defaults to false.'
					},
					exportPreprocess: {
						'!type': 'fn()',
						'!doc': 'A function which is called on the widget\'s data just prior to it being exported. It\'s first parameter is the widget\'s data and its return value should be the processed data.'
					},
					hasFooter: {
						'!type': 'bool',
						'!doc': 'Specifies if the widget should draw a header. Defaults to false.'
					},
					onDrawContentDone: {
						'!doc': ''
					},
					prepareContent: {
						'!doc': 'A function that will be called just before the Widget draws its content.'
					},
					description: {
						'!type': 'string',
						'!doc': 'Sets the description of the Widget, which will be shown in a tooltip attached to the header of the Widget.'
					}
				},
				defaultSettings: {
					processData: {
						'!type': 'fn(data:object)',
						'!doc': 'Executed from drawContent. Post-processes fetched data to prepare it for the widget.'
					},
					refreshData: {
						'!type': 'bool',
						'!doc': 'Specifies if the widget should re-fetch its data when an update is called on it. Defaults to false.'
					},
					useInputSettings: {
						'!type': 'bool',
						'!doc': 'Specifies if inputSettings should be applied to this widget\'s data requests. Defaults to true.'
					},
					ignoredInputSettings: {
						'!type': '[]',
						'!doc': 'An array containing the names of inputSettings which should be ignored by this widget. InputSettings passed to this widget which occur in this list will not be set.'
					},
					mobileDeviceDoubleTap: {
						'!type': 'bool',
						'!doc': 'Specifies if a double tap is required within this widget to have the effect of a single click when using a mobile device. Defaults to false.'
					},
					widgetButtongroupAlignment: {
						'!type': 'string',
						'!doc': 'Specifies the horizontal alignment of the widget\'s buttongroup. Defaults to \'right\'.'
					},
					widgetTitleColored: {
						'!type': 'bool',
						'!doc': 'Specifies whether the title of the widget should be effected by the "color" setting. Defaults to true.'
					}
				},
				SIZE: {
					SMALL: 'string',
					MEDIUM: 'string',
					LARGE: 'string'
				},
				POSITION: {
					BODY: 'string',
					HEADER: 'string',
					FOOTER: 'string',
					BUTTONGROUP: 'string'
				},
				'prototype': {
					'getData': {
						'!type': 'fn(requestId?: string) -> !this.data',
						'!doc': 'Returns this widget\'s data object\n\n@param {string} [requestId] The ID of the request\n\n@returns {object} This widget\'s data object'
					},
					'setData': {
						'!type': 'fn(data: ?) -> !this',
						'!doc': 'Used to set an object containing data for this widget to use and/or display\n\n@param {object} data An object containing data for this widget\n\n@returns {_DP.ComponentTypes.Widget} This object'
					},
					'draw': {
						'!type': 'fn() -> !this.bodyDOMElement',
						'!doc': 'Draws the widget inside its parent node.\nAdds a header if specified, including a title and subtitle if set.\nAdds a buttongroup to the header that will contain children components of\nthe \'Control\' class.\nAlso draws any associated children of the \'Popup\' class to the document\'s body.\nCreates references to its structural elements in the appropriate properties.\nApplies content dimensions to the body element if explicitly set.\nDraws the dummy image in its body if set.\n\n@param {HTMLElement} parentNode The node to draw itself in\n\n@returns {HTMLElement} This widget\'s body element'
					},
					'toggleEditMode': {
						'!type': 'fn() -> ?',
						'!doc': 'Calls toggleEditMode on its prototype, then hides the edit layer if editMode is disabled\n\n@augments _DP.ComponentTypes.DashboardComponent.toggleEditMode\n\n@returns {_DP.ComponentTypes.DashboardComponent}'
					},
					'setDummyImage': {
						'!type': 'fn(imagePath: string) -> !this',
						'!doc': 'Sets an image as content for this widget. Used for displaying dummy images\ninstead of an actual operational widget. For demo purposes.\n\n@param {string} imagePath The (relative) path to the image file\n\n@returns {_DP.ComponentTypes.Widget} This object'
					},
					'add': {
						'!type': 'fn(component: ?, draw?: bool) -> !this',
						'!doc': 'Adds another component to this widget\'s collection of children\n\n@param {DashboardComponent} component The component to add\n@param {boolean} [draw=true] Specifies whether the component should be drawn automatically by the widget\n\n@returns {_DP.ComponentTypes.Widget} This object'
					},
					'drawComponent': {
						'!type': 'fn(component: ?) -> !this',
						'!doc': 'Draws a widget\'s component in the appropriate spot depending on type\n\n@param {DashboardComponent} component A component belonging to this widget\n\n@returns {_DP.ComponentTypes.Widget} This object'
					},
					'update': {
						'!type': 'fn() -> ?',
						'!doc': 'Tells the widget to update itself. Calls fetchData if a dataTransporter\nobject is present and the component needs an update.\nOtherwise it simply calls the drawContent().\nIf the refreshData setting is set to false, the update is executed only the\nfirst time it is called.\n\n@param {object} inputSettings (optional) An inputSettings object.\n\n@returns {_DP.ComponentTypes.Widget} This object'
					},
					'fetchData': {
						'!type': 'fn()',
						'!doc': 'If a dataTransporter is set and while requestCount of the dataTransporter is larger than 0, it fetches\nall data for the dataTransporter.'
					},
					'setProcessData': {
						'!type': 'fn(processData: ?)',
					},
					'drawContent': {
						'!type': 'fn() -> !this',
						'!doc': 'Draws the widget\'s content inside the widget body.\n\n@returns {_DP.ComponentTypes.Widget} This object'
					},
					'clearContent': {
						'!type': 'fn() -> !this',
						'!doc': 'Removes the childNodes from the bodyDOMElement of the widget\n\n@returns {_DP.ComponentTypes.Widget} This object'
					},
					'copy': {
						'!type': 'fn() -> Widget.prototype.copy.!ret',
						'!doc': 'Returns a widget which is a copy of the current widget\n\n@returns {_DP.ComponentTypes.Widget} A copy of the current widget'
					},
					'fetchingDone': {
						'!type': 'fn() -> bool',
						'!doc': 'Sets the fetching property of the widget and the parent component to false\n\n@returns {_DP.ComponentTypes.Widget} This object'
					},
					'showError': {
						'!type': 'fn(message: string)',
						'!doc': 'Shows an error on top of the widget\n\n@param {string} message The error text to be shown'
					},
					'showFetching': {
						'!type': 'fn(options: ?)',
						'!doc': 'Shows an element which shows that the widget is fetching data'
					},
					'hideFetching': {
						'!type': 'fn()',
						'!doc': 'Hides the element which shows that the widget is fetching data'
					},
					'show': {
						'!type': 'fn() -> !this',
						'!doc': 'Shows the widget\n\n@returns {_DP.ComponentTypes.Widget} This object'
					},
					'hide': {
						'!type': 'fn() -> !this',
						'!doc': 'Hides the widget\n\n@returns {_DP.ComponentTypes.Widget} This object'
					},
					'addDataProcessor': {
						'!type': 'fn(dataProcessor: ?) -> !this',
						'!doc': 'Adds a data post-processing function to the end of the data-processing pipeline\n\n@param {function} dataProcessor A data processor function to be used with this widget\n\n@returns {_DP.ComponentTypes.Widget} This object'
					},
					'insertDataProcessor': {
						'!type': 'fn(dataProcessor: ?) -> !this',
						'!doc': 'Inserts a data post-processing function at the beginning of the data-processing pipeline\n\n@param {function} dataProcessor A data processor function to be used with this widget\n\n@returns {_DP.ComponentTypes.Widget} This object'
					},
					'link': {
						'!type': 'fn(linkedComponent: ?) -> !this',
						'!doc': 'Links a specific component to this Widget.\nIf this widget is an InputWidget, this causes any changes in the inputwidget to apply to that component\nand its children.\nAlso means that changing this inputwidget triggers an update for the\nlinked components and their children.\nIf no components are linked to an inputwidget, it defaults to the Dashboard.\nFor Widgets that are not InputWidgets, the behaviour varies.\nMultiple components can be linked to each widget.\n\n@param {DashboardComponent} linkedComponent A component controlled by this (input)widget\n\n@returns {_DP.ComponentTypes.Widget} This object'
					},
					'setBodyStyle': {
						'!type': 'fn(style: ?) -> !this',
						'!doc': 'Sets the CSS styling for the body of the widget\n\n@param {object} style An object containing styling keys and values Format: { [CSS parameter]: <string> - CSS value [CSS parameter]: <string> - CSS value [CSS parameter]: <string> - CSS value ... }\n\n@returns {_DP.ComponentTypes.Widget} This object'
					},
					'getBodyStyle': {
						'!type': 'fn() -> !this.bodyStyle',
						'!doc': 'Returns an object containing the CSS styling for the body of the widget\n\n@returns {object} An object containing CSS styling keys and values'
					},
					'drawTitle': {
						'!type': 'fn() -> !this',
						'!doc': 'Draws the title of the widget if the showTitle property of the widget is truthy\n\n@returns {object} The titleElement property of the widget'
					},
					'addDrawDoneEventHandler': {
						'!type': 'fn(handler: ?) -> !this',
						'!doc': 'Adds an event handler that will be executed once this widget is\ncompletely done drawing (this includes its content).\nThe function will only be executed once.\n\n@param {function} handler The function to be executed.\n\n@returns {_DP.ComponentTypes.Widget} This object.'
					},
					'setPosition': {
						'!type': 'fn(position: string) -> !this',
						'!doc': 'Sets the Widget\'s position within its parent.\nShould be one of the Widget.POSITION constants.\n\n@param {string} position The widget\'s position within its parent\n\n@returns {_DP.ComponentTypes.Widget} This object'
					},
					'createSubtitleElement': {
						'!type': 'fn() -> !this',
						'!doc': 'Creates a subtitle element for the widget\n\n@returns {_DP.ComponentTypes.Widget} This object'
					},
					'setSubtitle': {
						'!type': 'fn() -> !this',
						'!doc': 'Creates a subtitle element for the widget\n\n@param {Number} or The subtitle\n\n@returns {_DP.ComponentTypes.Widget} This object'
					},
					'setTitle': {
						'!type': 'fn(title: string) -> !this',
						'!doc': 'Sets the title element for the widget\n\n@param {string} title The title\n\n@returns {_DP.ComponentTypes.Widget} This object'
					},
					'showMessage': {
						'!type': 'fn(message: string) -> !this',
						'!doc': 'Shows a message on top of the widget.\n\n@returns {_DP.ComponentTypes.Widget} This object'
					},
					'hideMessage': {
						'!type': 'fn() -> !this',
						'!doc': 'Hides the message of the widget\n\n@returns {_DP.ComponentTypes.Widget} This object'
					},
					'enable': {
						'!type': 'fn() -> !this',
						'!doc': 'Sets the enable property of the widget to true and unblurs the widget\n\n@returns {_DP.ComponentTypes.Widget} This object'
					},
					'disable': {
						'!type': 'fn() -> !this',
						'!doc': 'Sets the enable property of the widget to false and blurs the widget\n\n@returns {_DP.ComponentTypes.Widget} This object'
					},
					'showDisabled': {
						'!type': 'fn() -> !this',
						'!doc': 'Unblurs the widget if its enabled property is truthy, blurs the widget otherwise\n\n@returns {_DP.ComponentTypes.Widget} This object'
					},
					'toJSON': {
						'!type': 'fn() -> Widget.prototype.toJSON.!ret',
						'!doc': 'Returns the contents of the Widget in JSON format.\nUsed for sending the formatted data to the backend for exporting and downloading.\n\n@returns {object} A JSON object representing the formatted contents of the Widget.'
					},
					'getExportData': {
						'!type': 'fn() -> ?',
						'!doc': 'Converts the current widget to JSON and returns it\n\n@returns {object} A JSON object with the current widget'
					},
					'getContainer': {
						'!type': 'fn() -> !this.container',
						'!doc': 'Returns the widget\'s Container object\n\n@returns {object} The widget\'s Container object'
					},
					'getDataTransporter': {
						'!type': 'fn() -> !this.dataTransporter',
						'!doc': 'Returns the widget\'s dataTransporter\n\n@returns {object} The widget\'s dataTransporter'
					},
					'getDataRequest': {
						'!type': 'fn(requestId: string) -> ?',
						'!doc': 'Returns the dataRequest with the provided requestId of the widget\'s dataTransporter\n\n@param {string} requestId The requestId of the data request\n\n@returns {object} The dataRequest with the provided requestId of the widget\'s dataTransporter'
					},
					'getLinkedComponents': {
						'!type': 'fn() -> !this.linkedComponents',
						'!doc': 'Returns an Array of the widget\'s linked components\n\n@returns {Array} An Array of the widget\'s linked components'
					},
					'getLinkedComponent': {
						'!type': 'fn(index: number) -> !this.linkedComponents.<i>',
						'!doc': 'Returns nth linkedComponent of the widget\n\n@param {Number} index The index of the requested nth linkedComponent\n\n@returns {object} The nth linked component specified by the index parameter'
					},
					'callOnLinkedComponents': {
						'!type': 'fn(func: string, args: [?], exclude: string) -> !this',
						'!doc': 'Call a function on the widget\'s linked components\n\n@param {string} func The name of the function that has to be called\n@param {Array} args An array of arguments for the function that will be called\n@param {string} exclude The linked component on which the function shouldn\'t be called on\n\n@returns {_DP.ComponentTypes.Widget} This object'
					},
					'setColor': {
						'!type': 'fn() -> !this',
						'!doc': 'Sets the color of the titleElement and subTitleElement properties\n\n@param {Mixed} color A Color object, HTML color string or a number from 0 to 255 indicating the red value\n@param {Number} green Optional. A number from 0 to 255 indicating the green value\n@param {Number} blue Optional. A number from 0 to 255 indicating the blue value\n\n@returns {_DP.ComponentTypes.Widget} This object'
					},
					'createEditLayer': {
						'!type': 'fn() -> !this',
						'!doc': 'Creates an edit layer\n\n@returns {_DP.ComponentTypes.Widget} This object'
					},
					'toggleEditLayer': {
						'!type': 'fn(show: bool) -> !this',
						'!doc': 'Hides or shows the edit layer\n\n@param {boolean} show true to show the edit layer, false to hide it\n\n@returns {_DP.ComponentTypes.Widget} This object'
					},
					'fitToColumn': {
						'!type': 'fn() -> ?',
						'!doc': 'Fits the widget inside its parent component\n\n@deprecated Use fitToParent instead\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'redraw': {
						'!type': 'fn() -> !this',
						'!doc': 'Redraws and updates the widget\n\n@returns {_DP.ComponentTypes.Widget} This object'
					},
					'setIndex': {
						'!type': 'fn(index: number)',
						'!doc': 'Sets the index property of the widget\n\n@param {Number} index The index'
					},
					'startResize': {
						'!type': 'fn(e: ?) -> bool',
						'!doc': 'Starts the resizing of the widget\n\n@param {Event} e The event object\n\n@returns {bool} false when the mouse event is triggered by the left mouse button, true otherwise'
					},
					'resize': {
						'!type': 'fn(e: ?) -> bool',
						'!doc': 'Resizes the Widget\n\n@param {Event} e The event object\n\n@returns {bool} false when the mouse event is triggered by the left mouse button, true otherwise'
					},
					'stopResize': {
						'!type': 'fn(e: ?) -> bool',
						'!doc': 'Stops resizing the Widget\n\n@param {Event} e The event object\n\n@returns {bool} false when the mouse event is triggered by the left mouse button, true otherwise'
					},
					'getSize': {
						'!type': 'fn() -> !this.size',
						'!doc': 'Returns the size property of the Widget\n\n@returns {string} \'small\', \'medium\' or \'large\''
					},
					'getSettingsPopup': {
						'!type': 'fn() -> string',
						'!doc': 'Returns the settings popup of the widget\'s dashboard\n\n@returns {string} \'small\', \'medium\' or \'large\''
					},
					'canUpdate': {
						'!type': 'fn() -> !this.isDrawn',
						'!doc': 'Returns whether the widget is in a state that allows it to update or not\n\n@returns {bool} true if the widget can update, false otherwise'
					},
				}
			},

			OutputWidget: {
				'!proto': 'Widget',
				properties: {
					legendElement: {
						'!doc': ''
					},
					hasHeader: {
						'!type': 'bool',
						'!doc': 'Specifies if the widget should draw a header. Defaults to false.'
					},
					allowExport: {
						'!type': 'bool',
						'!doc': 'Specifies if the widget should allow export.'
					}
				},
				defaultSettings: {
					refreshData: {
						'!type': 'bool',
						'!doc': ''
					},
					outputWidgetHasDownloadButton: {
						'!type': 'bool',
						'!doc': ''
					},
					outputWidgetHasMailButton: {
						'!type': 'bool',
						'!doc': ''
					},
					outputWidgetExportOptions: {
						'!type': '[]',
						'!doc': ''
					}
				},
				'prototype': {
					'draw': {
						'!type': 'fn() -> OutputWidget.prototype.draw.!ret',
					},
					'addExportButtons': {
						'!type': 'fn()',
					},
					'followLink': {
						'!type': 'fn() -> !this',
						'!doc': 'Applies inputsettings to the linked components and navigates to the first linked component.\n\n@returns {_DP.ComponentTypes.OutputWidget} This object'
					},
					'getExportOptions': {
						'!type': 'fn() -> [?]',
					},
					'email': {
						'!type': 'fn(format: string, address: ?, body: string, ccYourself: bool) -> !this',
						'!doc': 'Sends a request for download to the server containing the JSON content of this Widget.\n\n@param {string} format The file format to export to.\n@param {string} to The recipient\n@param {string} body Message body\n@param {boolean} ccYourself Whether to send a CC to the sender\'s address\n\n@returns {_DP.ComponentTypes.OutputWidget} This object'
					},
					'download': {
						'!type': 'fn(format: string) -> !this',
						'!doc': 'Sends a request for download to the server containing the JSON content of this Widget.\n\n@param {string} format The file format to export to.\n\n@returns {_DP.ComponentTypes.OutputWidget} This object'
					}
				}
			},

			Control: {
				'!proto': 'DashboardComponent',
				properties: {
					label: {
						'!type': 'string',
						'!doc': ''
					},
					onChange: {
						'!doc': ''
					},
					tooltipText: {
						'!type': 'string',
						'!doc': ''
					},
					inputSetting: {
						'!type': 'string',
						'!doc': ''
					},
					container: {
						'!doc': ''
					},
					enabled: {
						'!type': 'bool',
						'!doc': ''
					},
					eventControlNode: {
						'!doc': ''
					},
					position: {
						'!type': 'string',
						'!doc': ''
					},
					value: {
						'!doc': ''
					},
					linkedComponents: {
						'!type': '[]',
						'!doc': ''
					},
					propagateEvents: {
						'!type': 'bool',
						'!doc': ''
					},
					columnIndex: {
						'!type': 'number',
						'!doc': ''
					},
					bodyDOMElement: {
						'!doc': ''
					},
					validators: {
						'!type': '[]',
						'!doc': 'A collection of validator functions, of form: {validator: function, message: string}'
					},
					validationEvent: {
						'!type': 'string',
						'!doc': 'The event which automatically triggers validation. If made empty, validation will not be triggered.'
					}
				},
				POSITION: {
					BODY: 'string',
					HEADER: 'string',
					FOOTER: 'string',
					BUTTONGROUP: 'string',
					EDITHEADER: 'string'
				},
				'prototype': {
					'setInputSetting': {
						'!type': 'fn(inputSetting: string) -> !this',
						'!doc': 'Tells the control which input setting it controls\n\n@param {string} inputSetting The identifier (name) of the input setting\n\n@returns {_DP.ComponentTypes.Control} This object'
					},
					'getInputSetting': {
						'!type': 'fn() -> !this.inputSetting',
						'!doc': 'Returns the input setting controlled by this control.\n\n@returns {string} The name of the input setting controlled by this control'
					},
					'setContainer': {
						'!type': 'fn(container: ?) -> !this',
						'!doc': 'Sets a reference to the container this component belongs to\n\n@param {Container} container A reference to a Container object\n\n@returns {_DP.ComponentTypes.Control} This object'
					},
					'setTooltipText': {
						'!type': 'fn(tooltipText: string) -> !this',
						'!doc': 'Sets a the tooltip text for the control\n\n@param {string} tooltipText The text to display in the control\'s tooltip\n\n@returns {_DP.ComponentTypes.Control} This object'
					},
					'readInputSettings': {
						'!type': 'fn() -> Control.prototype.readInputSettings.!ret',
					},
					'disable': {
						'!type': 'fn() -> !this',
					},
					'enable': {
						'!type': 'fn() -> !this',
					},
					'setLabel': {
						'!type': 'fn(label: ?) -> !this',
					},
					'getLabel': {
						'!type': 'fn() -> !this.label',
					},
					'setPosition': {
						'!type': 'fn(position: string) -> !this',
						'!doc': 'Sets the Control\'s position within its parent.\nShould be one of the Control.POSITION constants.\n\n@param {string} position The control\'s position within its parent\n\n@returns {_DP.ComponentTypes.Control} This object'
					},
					'getValue': {
						'!type': 'fn() -> !this.value',
					},
					'setValue': {
						'!type': 'fn(value: ?) -> !this',
					},
					'hasFocus': {
						'!type': 'fn() -> bool',
					},
					'getContainer': {
						'!type': 'fn() -> !this.container',
					},
					'link': {
						'!type': 'fn(linkedComponent: ?) -> !this',
						'!doc': 'Links a specific component to this Control.\nMultiple components can be linked to each control.\n\n@param {DashboardComponent} linkedComponent A component controlled by this control\n\n@returns {_DP.ComponentTypes.Control} This object'
					},
					'getLinkedComponents': {
						'!type': 'fn() -> !this.linkedComponents',
					},
					'getLinkedComponent': {
						'!type': 'fn(index: ?) -> !this.linkedComponents.<i>',
					},
					'draw': {
						'!type': 'fn()',
					},
					'addValidator': {
						'!type': 'fn(validator: ?, message: string) -> !this',
						'!doc': 'Adds a validator function, which will be executed against the value when validate() is called.\n\n@param {function} validator The validation function\n@param {string} message The message that should be displayed when the validation fails\n\n@returns {_DP.ComponentTypes.Control} This object'
					},
					'validate': {
						'!type': 'fn() -> bool',
						'!doc': 'Runs the validators against the value and shows the appropriate message when a validation fails\n\n@returns {boolean} True if the validation succeeded, false if it failed'
					},
					'setValidationEvent': {
						'!type': 'fn(event: string) -> !this',
						'!doc': 'Sets the name of the event that should trigger validation\n\n@param {string} event The name of the event\n\n@returns {_DP.ComponentTypes.Control} This object'
					},
					'update': {
						'!type': 'fn() -> !this',
						'!doc': '@augments _DP.ComponentTypes.DashboardComponent#update\n@returns {_DP.ComponentTypes.Control} This object'
					}
				}
			},

			Container: {
				'!proto': 'DashboardComponent',
				'!doc': 'Base class for all container-type components. E.g.: Blocks, Toolbars, Popups, Tooltips.',
				properties: {
					hasHeader: {
						'!type': 'bool',
						'!doc': 'Whether the container has a header'
					},
					hasFooter: {
						'!type': 'bool',
						'!doc': 'Whether the container has a footer'
					},
					bodyStyle: {
						'!doc': 'Style for the container body element'
					},
					columnWidths: {
						'!type': '[]',
						'!doc': 'List of column widths'
					},
					columnIndex: {
						'!type': 'number',
						'!doc': 'Parent container column index'
					},
					maxContentHeight: {
						'!type': 'number',
						'!doc': 'Maximum height of the body element or -1 for not set'
					},
					columnCount: {
						'!type': 'number',
						'!doc': 'Number of columns'
					}
				},
				defaultSettings: {
					titleColored: {
						'!type': 'bool',
						'!doc': ''
					},
					containerHasRoundedCorners: {
						'!type': 'bool',
						'!doc': ''
					},
					containerTransitionEffect: {
						'!type': 'string',
						'!doc': ''
					},
					containerHasDownloadButton: {
						'!type': 'bool',
						'!doc': ''
					},
					containerHasMailButton: {
						'!type': 'bool',
						'!doc': ''
					},
					containerExportOptions: {
						'!type': '[]',
						'!doc': ''
					},
					containerUseBorderColor: {
						'!type': 'bool',
						'!doc': ''
					},
					containerButtongroupAlignment: {
						'!type': 'string',
						'!doc': ''
					}
				},
				TRANSITION_EFFECT: {
					FADE: 'string',
					SLIDE: 'string',
					NONE: 'string',
					SLIDE_RIGHT: 'string'
				},
				'prototype': {
					'draw': {
						'!type': 'fn() -> !this.DOMElement',
						'!doc': 'Draws the container, including a header and footer if specified, and all its components.\n\n@returns This container\'s body element.'
					},
					'add': {
						'!type': 'fn(component: ?, before?: ?) -> !this',
						'!doc': 'Adds a component to this container.\n\n@param {_DP.ComponentTypes.DashboardComponent} component The component to add\n@param {HTMLElement} [before] The DOM node before which the new component will be inserted\n@param {boolean} [markAsModified=false] Whether to mark the component as added for editMode purposes\n\n@returns {_DP.ComponentTypes.Container} This object'
					},
					'addButton': {
						'!type': 'fn(button: ?) -> !this',
						'!doc': 'Adds a button to this container, that will be shown in the header.\n\n@deprecated Use add()\n\n@param {Button} button The button to add.\n\n@returns {_DP.ComponentTypes.Container} This object'
					},
					'addInputWidget': {
						'!type': 'fn(inputWidget: ?) -> !this',
						'!doc': 'Adds an InputWidget to this container, that will be shown in the header.\n\n@deprecated\n\n@param {InputWidget} inputWidget The input widget to add.\n\n@returns {_DP.ComponentTypes.Container} This object'
					},
					'update': {
						'!type': 'fn()',
						'!doc': 'Updates this container\'s content based on new input settings.\n\n@returns {*} Return value of superclass\'s update method.'
					},
					'copy': {
						'!type': 'fn() -> Container.prototype.copy.!ret',
						'!doc': 'Returns a copy of this container and all its contents.\n\n@returns {_DP.ComponentTypes.Container} An identical, but independent, copy of this object.'
					},
					'clearContent': {
						'!type': 'fn() -> !this',
						'!doc': 'Clears this container\'s content.\nRemoves all DOM elements from the container body and empties the component list.\n\n@returns {_DP.ComponentTypes.Container} This object.'
					},
					'drawContent': {
						'!type': 'fn() -> !this',
						'!doc': 'Draws this container\'s body content.\nAdds columns as necessary and draws the components (widgets) in the corresponding columns.\n\n@returns {_DP.ComponentTypes.Container} This object'
					},
					'show': {
						'!type': 'fn(callback: ?, transitionEffect: string) -> !this',
						'!doc': 'Shows the Container, if it is hidden.\nOptionally calls a callback function when done showing.\nA transition effect (animation) can be specified to be used for the show. If\nnone is specified the setting \'containerTransitionEffect\' is used.\n\n@param {function} callback\n@param {string} transitionEffect\n\n@returns {_DP.ComponentTypes.Container} This object'
					},
					'hide': {
						'!type': 'fn(callback: ?, transitionEffect: string) -> !this',
						'!doc': 'Hides the Container, if it is shown.\nOptionally calls a callback function when done hiding.\nA transition effect (animation) can be specified to be used for the hide. If\nnone is specified the setting \'containerTransitionEffect\' is used.\n\n@param {function} callback\n@param {string} transitionEffect\n\n@returns {_DP.ComponentTypes.Container} This object'
					},
					'hideCallback': {
						'!type': 'fn(callback: ?)',
						'!doc': 'Handles whatever needs to be done after a hiding animation finishes.\nAdds the _hidden class, fires the afterHide handler and calls the hide()\ncallback.\n\n@param {function} callback The callback function as passed to the hide() method.\n\n@returns {_DP.ComponentTypes.Container} This object'
					},
					'toggle': {
						'!type': 'fn(show?: bool, callback?: ?, transitionEffect?: string) -> !this',
						'!doc': 'Toggles the Container\'s visibility. Calls hide() when the Container is shown and show() when it is hidden.\n\n@param {boolean} [show] Specifies whether to show or hide the component.\n@param {function} [callback] A function which will be executed after the transition.\n@param {string} [transitionEffect] An effect to use for the transition. One of the Container.TRANSITION_EFFECT constants.\n\n@returns {_DP.ComponentTypes.Container} This object'
					},
					'removeAnimationViewport': {
						'!type': 'fn() -> !this',
						'!doc': 'After a transition animation that relies on th animation viewport this function can be called\nto remove the viewport from the DOM and to replace it with the container\'s DOM element\n\n@see _DP.ComponentTypes.Container#showCallback\n@see _DP.ComponentTypes.Container#hideCallback\n\n@returns {_DP.ComponentTypes.Container} This object'
					},
					'download': {
						'!type': 'fn(format: string, options: ?) -> !this',
						'!doc': 'Sends a request for download to the server containing the JSON content of all components of this Container.\n\n@param {string} format The file format to export to.\n@param {object} options Export options\n\n@returns {_DP.ComponentTypes.Container} This object'
					},
					'email': {
						'!type': 'fn(format: string, address: string, body: string, ccYourself: bool, options: ?) -> !this',
						'!doc': 'Sends a request for download to the server containing the JSON content of this Widget.\n\n@param {string} format The file format to export to.\n@param {string} address The recipient\'s address\n@param {string} body Message for the recipient\n@param {boolean} ccYourself Whether to send a CC to the sender\'s address\n@param {object} options Export options\n\n@returns {_DP.ComponentTypes.Container} This object'
					},
					'setData': {
						'!type': 'fn()',
						'!doc': 'Calls the setData method of all the container\'s components.\n\n@returns {*}'
					},
					'setBodyStyle': {
						'!type': 'fn(style: ?) -> !this',
						'!doc': 'Sets the body style.\n\n@param {object} style\n\n@returns {_DP.ComponentTypes.Container} This object'
					},
					'getBodyStyle': {
						'!type': 'fn() -> !this.bodyStyle',
						'!doc': 'Returns the body style.\n\n@returns {Object|*}'
					},
					'setTitle': {
						'!type': 'fn(title: string)',
						'!doc': 'Sets the title.\n\n@param {string} title\n\n@returns {*}'
					},
					'redrawContent': {
						'!type': 'fn() -> !this',
						'!doc': 'Clears and then draws the content again.\n\n@returns {_DP.ComponentTypes.Container} This object'
					},
					'orderComponents': {
						'!type': 'fn(columnIndex?: number) -> !this',
						'!doc': 'Orders the container\'s components in the given column,\nor all columns (if columnIndex is omitted).\n\n@param {number} [columnIndex]\n\n@returns {_DP.ComponentTypes.Container} This object'
					},
					'destroy': {
						'!type': 'fn()',
						'!doc': 'Clears the content and calls the superclass\'s destroy method.\n\n@returns {*}'
					},
					'getExportOptions': {
						'!type': 'fn() -> [?]',
						'!doc': 'Returns the export options.\n\n@returns {Array} The export options'
					},
					'setColor': {
						'!type': 'fn() -> !this',
						'!doc': 'Sets the color.\n\n@returns {_DP.ComponentTypes.Container} This object'
					},
					'setMaxContentHeight': {
						'!type': 'fn(maxContentHeight: number) -> !this',
						'!doc': 'Sets the maximum content height of the body DOM element.\n\n@param {number} maxContentHeight\n\n@returns {_DP.ComponentTypes.Container} This object'
					},
					'toggleEditMode': {
						'!type': 'fn()',
						'!doc': 'Toggles the edit mode on or off.\n\n@returns {*}'
					},
					'setSubtitle': {
						'!type': 'fn() -> !this',
						'!doc': 'Sets the subtitle.\n\n@returns {_DP.ComponentTypes.Container} This object'
					},
					'recalculateColumns': {
						'!type': 'fn(options: ?) -> !this',
						'!doc': 'Recalculates the column widths.\n\n@param {object} options\n@config {number} [oldColumnCount] The original columncount of the container\n@config {number} [newColumnCount] The new columncount of the container\n@config {number} [oldContentWidth] The original content width of the container\n@config {number} [newContentWidth] The new content width of the container\n\n@returns {_DP.ComponentTypes.Container} This object'
					},
					'addColumn': {
						'!type': 'fn() -> !this',
						'!doc': 'Adds a column to the container\n\n@returns {_DP.ComponentTypes.Container} This object'
					},
					'removeColumn': {
						'!type': 'fn(index: number) -> !this',
						'!doc': 'Removes a column from the container and moves its contents to the previous column.\nDefaults to the last (rightmost) column if no index is specified.\n\n@param {number} index Specifies which column to remove. Defaults to the last (rightmost) column\n\n@returns {_DP.ComponentTypes.Container} This object'
					},
					'moveColumnComponents': {
						'!type': 'fn(sourceIndex: number, targetIndex: number) -> !this',
						'!doc': 'Moves the contents of the source column to the target column\n\n@param {number} sourceIndex Index of the column that is the source of the components to be moved\n@param {number} targetIndex Index of the column that is the target of the components to be moved\n\n@returns {_DP.ComponentTypes.Container} This object'
					},
					'getColumnCount': {
						'!type': 'fn() -> !this.columnCount',
						'!doc': 'Returns the number of columns.\n\n@returns {number}'
					},
					'setColumnCount': {
						'!type': 'fn(count: number) -> !this',
						'!doc': 'Sets the number of columns.\n\n@param {number} count\n\n@returns {_DP.ComponentTypes.Container} This object'
					},
					'getColumnWidths': {
						'!type': 'fn() -> [?]',
						'!doc': 'Returns an array with the column widths.\n\n@returns {Array}'
					},
					'setColumnWidths': {
						'!type': 'fn(widths: [number]) -> !this',
						'!doc': 'Sets the column widths.\n\n@param {Array} widths\n\n@returns {_DP.ComponentTypes.Container} This object'
					},
					'fitToParent': {
						'!type': 'fn() -> !this',
						'!doc': 'Resizes the container to snugly fit inside its parent element and rescales the columns to match\n\n@returns {_DP.ComponentTypes.Container} This object'
					},
					'undraw': {
						'!type': 'fn() -> ?',
						'!doc': '@augments _DP.ComponentTypes.DashboardComponent#undraw\n\n@see _DP.ComponentTypes.DashboardComponent#undraw\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
					'remove': {
						'!type': 'fn() -> ?',
						'!doc': '@augments _DP.ComponentTypes.DashboardComponent#remove\n\n@see _DP.ComponentTypes.DashboardComponent#remove\n\n@returns {_DP.ComponentTypes.DashboardComponent}'
					},
				}
			},

			AudioPlayer: {
				'!proto': 'OutputWidget',
				'prototype': {
					'draw': {
						'!type': 'fn()',
						'!doc': 'Draws the audio player'
					},
					'drawContent': {
						'!type': 'fn()',
						'!doc': 'Draws the audio player\'s content'
					},
					'applyDimensions': {
						'!type': 'fn()',
						'!doc': 'Applies the component\'s width and height'
					}
				}
			},

			Block: {
				'!proto': 'Container'
			},

			Breadcrumbs: {
				'!proto': 'Widget',
				properties: {
					crumbs: {
						'!type': '[]',
						'!doc': ''
					},
					linkedComponents: {
						'!type': '[]',
						'!doc': ''
					},
					listElement: {
						'!doc': ''
					}
				},
				defaultSettings: {
					breadcrumbsSeparatorChar: {
						'!type': 'string',
						'!doc': "The breacrumb seperator character, defaults to '>'"
					}
				},
				'prototype': {
					'draw': {
						'!type': 'fn() -> !this.bodyDOMElement',
						'!doc': 'Draws the breadcrumbs widget.\n\n@augments _DP.ComponentTypes.Widget#draw\n@augments _DP.ComponentTypes.DashboardComponent#draw\n\n@returns {HTMLDivElement} The body element of the widget.'
					},
					'drawContent': {
						'!type': 'fn() -> !this',
						'!doc': 'Draws the breadcrumbs inside the widget body.\n\n@returns {_DP.ComponentTypes.Breadcrumbs} This object'
					},
					'addCrumb': {
						'!type': 'fn(label: string, settings: ?, onClick: ?, isLast: bool) -> !this',
						'!doc': 'Adds one crumb to the end of the breadcrumbs trail.\n\n@param {string} label A label for the breadcrumb\n@param {object} settings (Optional) A settings object which will be applied to this widget\'s linked component when the breadcrumb is clicked.\n@param {function} onClick (Optional) An event handler which will be executed when the breadcrumb is clicked.\n@param {boolean} isLast (Optional) Specifies that the crumb added is the deepest level. False if omitted.\n\n@returns {_DP.ComponentTypes.Breadcrumbs} This object'
					},
					'gotoCrumb': {
						'!type': 'fn(index: number) -> !this',
						'!doc': 'Is called when a breadcrumb is clicked.\nApplies any associated settings to the linked component and fires the onClick event handler.\n\n@param {number} index The index of the breadcrumb that was clicked.\n\n@returns {_DP.ComponentTypes.Breadcrumbs} This object'
					},
					'setCrumbLabel': {
						'!type': 'fn(index: number, label: string) -> !this',
						'!doc': 'Changes the label of a particular breadcrumb to something else.\n\n@param {number} index The index of the breadcrumb to change.\n@param {string} label The new label for the breadcrumb.\n\n@returns {_DP.ComponentTypes.Breadcrumbs} This object'
					}
				}
			},

			Button: {
				'!proto': 'Control',
				SIZE: {
					SMALL: 'string',
					LARGE: 'string'
				},
				BUTTON_STYLE: {
					BUTTON: 'string',
					LINK: 'string',
					IMAGE: 'string'
				},
				properties: {
					imageName: {
						'!type': 'string',
						'!doc': ''
					},
					opacity: {
						'!type': 'number',
						'!doc': ''
					},
					alwaysColored: {
						'!type': '',
						'!doc': 'bool'
					},
					labelAlwaysColored: {
						'!type': 'bool',
						'!doc': ''
					},
					imageAlwaysColored: {
						'!type': 'bool',
						'!doc': ''
					},
					size: {
						'!type': 'string',
						'!doc': '',
						'!data': 'Button.SIZE'
					},
					referenceById: {
						'!type': 'bool',
						'!doc': ''
					},
					linkUrl: {
						'!type': 'string',
						'!doc': ''
					},
					useHoverColor: {
						'!type': 'bool',
						'!doc': ''
					},
					buttonStyle: {
						'!type': 'string',
						'!doc': '',
						'!data': 'Button.BUTTON_STYLE'
					},
					imageOffsetX: {
						'!type': 'number',
						'!doc': ''
					},
					imageOffsetY: {
						'!type': 'number',
						'!doc': ''
					},
					imageWidth: {
						'!type': 'number',
						'!doc': ''
					},
					imageHeight: {
						'!type': 'number',
						'!doc': ''
					},
					hoverImageOffsetX: {
						'!type': 'number',
						'!doc': ''
					},
					hoverImageOffsetY: {
						'!type': 'number',
						'!doc': ''
					},
					disabledImageOffsetX: {
						'!type': 'number',
						'!doc': ''
					},
					disabledImageOffsetY: {
						'!type': 'number',
						'!doc': ''
					},
					backgroundImage: {
						'!type': 'string',
						'!doc': ''
					},
					disabledBackgroundImage: {
						'!type': 'string',
						'!doc': ''
					},
					leftCapImage: {
						'!type': 'string',
						'!doc': ''
					},
					rightCapImage: {
						'!type': 'string',
						'!doc': ''
					},
					activeBackgroundImage: {
						'!type': 'string',
						'!doc': ''
					},
					position: {
						'!type': 'string',
						'!doc': '',
						'!data': 'Control.POSITION'
					},
					selected: {
						'!type': 'bool',
						'!doc': ''
					},
					useDisabledColorMask: {
						'!type': 'bool',
						'!doc': ''
					},
					selectedImageOffsetX: {
						'!type': 'number',
						'!doc': ''
					},
					selectedImageOffsetY: {
						'!type': 'number',
						'!doc': ''
					},
					imageElement: {
						'!doc': ''
					},
					imageWrapperElement: {
						'!doc': ''
					},
					hiddenElement: {
						'!doc': ''
					},
					buttonElement: {
						'!doc': ''
					},
					useHoverOffset: {
						'!type': '',
						'!doc': ''
					},
					useDisabledOffset: {
						'!type': 'bool',
						'!doc': ''
					},
					useSelectedOffset: {
						'!type': 'bool',
						'!doc': ''
					},
					labelElement: {
						'!doc': ''
					},
					highlighted: {
						'!type': 'bool',
						'!doc': ''
					}
				},
				defaultSettings: {
					applyImageColorMask: {
						'!type': 'bool',
						'!doc': 'Whether to apply an image color mask for IE, defaults to true'
					},
					buttonHideCaps: {
						'!type': 'bool',
						'!doc': ''
					}
				},
				'prototype': {
					'draw': {
						'!type': 'fn() -> Button.prototype.draw.!ret',
						'!doc': 'Draws the button within its parent node, including a label and an image if set.\nApplies the set color to label and image.\nAttaches hover events.\n\n@param {HTMLElement} parentNode The node to draw itself in\n\n@returns {} void'
					},
					'setImage': {
						'!type': 'fn(imageName: string) -> !this',
						'!doc': 'Sets the image to use for this button by specifying a name.\nThe path is determined by the theme, the extension used is always .png.\n\n@param {string} imageName The name of the image (filename without path and extension)\n\n@returns {_DP.ComponentTypes.Button} This object'
					},
					'getImage': {
						'!type': 'fn() -> !this.imageName',
					},
					'setSize': {
						'!type': 'fn(size: string) -> !this',
						'!doc': 'Sets the size of the button, accepts any of the property values from the\nconstant Button.SIZE.\n\n@param {string} size A string indicating the size, one of the property values of this.SIZE\n\n@returns {_DP.ComponentTypes.Button} This Object'
					},
					'getSize': {
						'!type': 'fn() -> !this.size',
						'!doc': 'Returns the size of the button, as a string from one of the property values of this.SIZE\n\n@returns {string} The size'
					},
					'setOpacity': {
						'!type': 'fn(opacity: number) -> !this',
						'!doc': 'Sets the button\'s opacity when inactive\n\n@param {number} opacity A fraction from 0 to 1 indicating the button\'s opacity\n\n@returns {_DP.ComponentTypes.Button} This object'
					},
					'getOpacity': {
						'!type': 'fn() -> !this.opacity',
						'!doc': 'Returns the button\'s opacity when inactive\n\n@returns {float} A fraction from 0 to 1 indicating the button\'s opacity'
					},
					'setAlwaysColored': {
						'!type': 'fn(alwaysColored: bool) -> !this',
						'!doc': 'Sets whether the button should use its color only when hovering (false) or\nall the time (true).\n\n@param {boolean} alwaysColored Optional. False indicates that the button does not apply its color until the user hovers the mouse over it. True means the button is always colored. If the argument is omitted, True will be used.\n\n@returns {_DP.ComponentTypes.Button} This object'
					},
					'setLabelAlwaysColored': {
						'!type': 'fn(alwaysColored: bool) -> !this',
						'!doc': 'Sets whether the button\'s label should use its color only when hovering (false) or\nall the time (true).\n\n@param {boolean} alwaysColored Optional. False indicates that the label does not apply its color until the user hovers the mouse over the button. True means the label is always colored. If the argument is omitted, True will be used.\n\n@returns {_DP.ComponentTypes.Button} This object'
					},
					'setImageAlwaysColored': {
						'!type': 'fn(alwaysColored: bool) -> !this',
						'!doc': 'Sets whether the button\'s image should use its color only when hovering (false) or\nall the time (true).\n\n@param {boolean} alwaysColored Optional. False indicates that the image does not apply its color until the user hovers the mouse over the button. True means the image is always colored. If the argument is omitted, True will be used.\n\n@returns {_DP.ComponentTypes.Button} This object'
					},
					'getAlwaysColored': {
						'!type': 'fn() -> !this.alwaysColored',
						'!doc': 'Returns whether the button should use its color only when hovering (false)\nor all the time (true).\n\n@returns {boolean} False indicates that the button does not apply its color until the\nuser hovers the mouse over it. True means the button is always colored.\nThe default value is False.'
					},
					'getLabelAlwaysColored': {
						'!type': 'fn() -> !this.labelAlwaysColored',
						'!doc': 'Returns whether the button\'s label should use its color only when hovering\n(false) or all the time (true).\n\n@returns {boolean} False indicates that the label does not apply its color until the\nuser hovers the mouse over the button. True means the label is always\ncolored. The default value is False.'
					},
					'getImageAlwaysColored': {
						'!type': 'fn() -> !this.imageAlwaysColored',
						'!doc': 'Returns whether the button\'s image should use its color only when hovering\n(false) or all the time (true).\n\n@returns {boolean} False indicates that the image does not apply its color until the\nuser hovers the mouse over the button. True means the image is always\ncolored. The default value is False.'
					},
					'setReferenceById': {
						'!type': 'fn(referenceById: bool) -> !this',
						'!doc': 'Sets whether this button\'s DOM element should be referenced by Id instead of\nDOM node reference as usual.\nWhen this is set to true, whenever the button needs a reference to its DOM\nelement, it creates a new reference based on its elementID property, instead\nof using its DOMElement property.\n\n@param {boolean} referenceById Flag indicating whether this setting should be enabled or disabled. Omitting this argument defaults to true.\n\n@returns {_DP.ComponentTypes.Button} This object.'
					},
					'startHover': {
						'!type': 'fn() -> !this',
					},
					'stopHover': {
						'!type': 'fn() -> !this',
					},
					'applyStateBasedStyle': {
						'!type': 'fn() -> !this',
					},
					'setLinkUrl': {
						'!type': 'fn(linkUrl: string) -> !this',
						'!doc': 'Turns this button into a link to the specified URL.\n\n@param {string} linkUrl The URL or URI that the browser should navigate to when this button is clicked.\n\n@returns {_DP.ComponentTypes.Button} This object.'
					},
					'setButtonStyle': {
						'!type': 'fn(buttonStyle: ?) -> !this',
					},
					'getButtonStyle': {
						'!type': 'fn() -> !this.buttonStyle',
					},
					'setImageOffset': {
						'!type': 'fn(x: ?, y: ?, width: ?, height: ?, hoverX: ?, hoverY: ?) -> !this',
					},
					'setUseHoverColor': {
						'!type': 'fn(useHoverColor: ?) -> !this',
					},
					'createIEColorMask': {
						'!type': 'fn()',
					},
					'disable': {
						'!type': 'fn() -> !this',
						'!doc': 'Disables the button. Removes the click and hover event handlers and applies the disabled style.\n\n@augments _DP.ComponentTypes.Control#disable\n\n@returns {_DP.ComponentTypes.Button} This object'
					},
					'enable': {
						'!type': 'fn() -> !this',
					},
					'setTooltipText': {
						'!type': 'fn(tooltipText: string) -> !this',
						'!doc': 'Sets a the tooltip text for the button\n\n@param {string} tooltipText The text to display in the button\'s tooltip\n\n@returns {_DP.ComponentTypes.Button} This object'
					},
					'select': {
						'!type': 'fn() -> !this',
					},
					'deselect': {
						'!type': 'fn() -> !this',
					}
				}
			},

			ButtonGroup: {
				'!proto': 'Widget',
				'!doc': 'Widget that can contain a number of Buttons',
				ALIGNMENT: {
					LEFT: 'string',
					RIGHT: 'string'
				},
				properties: {
					showButtonSeparators: {
						'!type': 'bool',
						'!doc': 'Whether to show a separator between the buttons'
					},
					buttonStyle: {
						'!type': 'string',
						'!doc': 'The style for the buttons. See _DP.ComponentTypes.Button.BUTTON_STYLE',
						'!data': 'Button.BUTTON_STYLE'
					},
					buttonSize: {
						'!type': 'string',
						'!doc': 'The style for the buttons. See _DP.ComponentTypes.Button.SIZE',
						'!data': 'Button.SIZE'
					},
					imageName: {
						'!type': 'string',
						'!doc': 'The default image for the buttons'
					},
					alignment: {
						'!type': 'string',
						'!doc': 'The alignment for the Buttons within the ButtonGroup. Default is based on context',
						'!data': 'ButtonGroup.ALIGNMENT'
					}
				},
				'prototype': {
					'add': {
						'!type': 'fn(component: ButtonGroup._buttons.<i>) -> !this',
						'!doc': 'If the component being added is a Button, it adds a ButtonSeparator if necessary and sets the appropriate\nproperties on the Button\n\n@augments _DP.ComponentTypes.Widget#add\n\n@param {_DP.ComponentTypes.DashboardComponent} component The component to add\n\n@returns {_DP.ComponentTypes.ButtonGroup} This object'
					},
					'disable': {
						'!type': 'fn() -> !this',
						'!doc': 'Disables all buttons in button group\n\n@returns {_DP.ComponentTypes.ButtonGroup}'
					},
					'enable': {
						'!type': 'fn() -> !this',
						'!doc': 'Enables all buttons in button group\n\n@returns {_DP.ComponentTypes.ButtonGroup}'
					}
				}
			},

			ButtonSeparator: {
				'!proto': 'Control',
				'!doc': 'Control representing the line that can be used to seperate buttons in a \nbutton group. Is its own class so it can be added to button groups at will.',
				properties: {
					position: {
						'!type': 'string',
						'!doc': 'Control position Control.POSITION.BODY, Control.POSITION.HEADER, Control.POSITION.FOOTER, Control.POSITION.BUTTONGROUP, Control.POSITION.EDITHEADER',
						'!data': 'Control.POSITION'
					}
				},
				'prototype': {
					'draw': {
						'!type': 'fn(parentNode: ?) -> ButtonSeparator.prototype.draw.!ret',
						'!doc': 'Draws the separator\n\n@param {}  parentNode <HTMLElement>\n\n@returns {HTMLElement}'
					}
				}
			},

			Checkbox: {
				'!proto': 'Control',
				properties: {
					labelElement: {
						'!doc': ''
					},
					inputElement: {
						'!doc': ''
					},
					value: {
						'!type': 'number',
						'!doc': ''
					},
					checked: {
						'!type': 'bool',
						'!doc': ''
					}
				},
				'prototype': {
					'draw': {
						'!type': 'fn() -> !this.DOMElement',
						'!doc': 'Draws the checkbox in its parent node and adds any appropriate event handlers\n\n@param {HTMLElement} parentNode The node to draw itself in\n\n@returns {HTMLElement} This object\'s outer DOM element'
					},
					'setValue': {
						'!type': 'fn(value: number) -> !this',
						'!doc': 'Sets the value of the checkbox\n\n@param {number} value The value of the checkbox\n\n@returns {_DP.ComponentTypes.Checkbox} This object'
					},
					'setChecked': {
						'!type': 'fn(checked: bool) -> !this',
						'!doc': 'Sets whether the checkbox is checked\n\n@param {boolean} checked Checked if true or omitted, unchecked if false, unchanged if otherwise.\n\n@returns {_DP.ComponentTypes.Checkbox} This object'
					},
					'getChecked': {
						'!type': 'fn() -> !this.inputElement.checked',
						'!doc': 'Returns whether the checkbox is checked\n\n@returns {bool} Whether the checkbox is checked.'
					}
				}
			},

			CodeEditor: {
				'!proto': 'TextInputWidget',
				properties: {
					multiLine: {
						'!type': 'bool',
						'!doc': ''
					},
					validateAndFormatTimeout: {
						'!type': 'number',
						'!doc': ''
					},
					codeMirrorSettings: {
						'!doc': "{theme: 'default', lineNumbers: true}",
						theme: 'string',
						lineNumbers: 'bool'
					},
					jsHint: {
						'!doc': "{enabled : false, options : { maxerr : 4, smarttabs: true, '-W099': true, '-W108': true, laxbreak: true}}",
						enabled: 'bool',
						options: {
							maxerr: 'bool',
							smarttabs: 'bool',
							'-W099': 'bool',
							'-W108': 'bool',
							laxbreak: 'bool'
						}
					},
					jsBeautify: {
						'!doc': '{enabled : false, options : {}}',
						enabled: 'bool',
						options: ''
					}
				},
				'prototype': {
					'draw': {
						'!type': 'fn()',
					},
					'drawContent': {
						'!type': 'fn()',
					},
					'clear': {
						'!type': 'fn() -> !this',
					},
					'setValue': {
						'!type': 'fn(value: string) -> !this',
					},
					'getValue': {
						'!type': 'fn() -> !this.value',
					},
					'format': {
						'!type': 'fn() -> !this',
					},
					'validate': {
						'!type': 'fn()',
					},
					'validateAndFormat': {
						'!type': 'fn(format: bool)',
					}
				}
			},

			ColorPicker: {
				'!proto': 'Control',
				properties: {
					colors: {
						'!type': '[]',
						'!doc': "[colors=['#264283', '#007DC3', '#A2AD00', '#C1BB00', '#9B1F23', '#DC291E', '#F0AB00', '#F6D50F', '#8E8581', '#fff', '#000']] An array of HTML color codes which is used to populate the color picker. Defaults to a set of GfK colors"
					}
				},
				'prototype': {
					'draw': {
						'!type': 'fn()',
						'!doc': 'Draws the color picker\n\n@augments _DP.ComponentTypes.Control#draw'
					},
					'setValue': {
						'!type': 'fn(value: ?) -> !this',
						'!doc': 'Sets the new value for the color picker\n\n@param {}  value <string>/<Color> - The new value\n\n@returns {_DP.ComponentTypes.ColorPicker} This object'
					},
					'getValue': {
						'!type': 'fn() -> !this.value',
						'!doc': 'Returns the current value of the color picker\n\n@returns {Color} The current value'
					},
					'showColorPicker': {
						'!type': 'fn() -> !this',
						'!doc': 'Displays the color selection popout\n\n@returns {_DP.ComponentTypes.ColorPicker} This object'
					},
					'hideColorPicker': {
						'!type': 'fn() -> !this',
						'!doc': 'Hides the color selection popout\n\n@returns {_DP.ComponentTypes.ColorPicker} This object'
					},
					'undraw': {
						'!type': 'fn()',
						'!doc': 'Removes all DOM Elements belonging to this component\n\n@augments _DP.ComponentTypes.DashboardComponent#undraw'
					}
				}
			},

			ColorSchemeEditor: {
				'!proto': 'InputWidget',
				properties: {
					labels: {
						'!type': '[]',
						'!doc': ''
					},
					hasResetButton: {
						'!type': 'bool',
						'!doc': ''
					},
					hasSettingsButton: {
						'!type': 'bool',
						'!doc': ''
					},
					hasPopup: {
						'!type': 'bool',
						'!doc': ''
					}
				},
				'prototype': {
					'draw': {
						'!type': 'fn()',
					},
					'drawContent': {
						'!type': 'fn() -> !this',
						'!doc': 'Draws the ColorPickers within the ColorSchemeEditor\n\n@augments _DP.ComponentTypes.Widget#drawContent\n\n@returns {_DP.ComponentTypes.ColorSchemeEditor} self'
					},
					'removeInput': {
						'!type': 'fn(index: number) -> !this',
						'!doc': 'Removes an input control (ColorPicker)\n\n@param {number} index The index of the input control to remove\n\n@returns {_DP.ComponentTypes.ColorSchemeEditor} This object'
					},
					'getValue': {
						'!type': 'fn() -> ?',
						'!doc': 'Returns the current value of the ColorSchemeEditor\n\n@returns {_DP.ColorScheme} The current value'
					},
					'setValue': {
						'!type': 'fn(value: ?|[?]) -> !this',
						'!doc': 'Assigns a new value to the ColorSchemeEditor\n\n@param {_DP.ColorScheme|Array|object} value The colors or colorscheme to use as the new value\n\n@returns {_DP.ComponentTypes.ColorSchemeEditor} self'
					}
				}
			},

			Dashboard: {
				'!proto': 'DashboardComponent',
				properties: {
					pages: {
						'!type': '[]',
						'!doc': ''
					},
					currentPageNumber: {
						'!type': 'number',
						'!doc': ''
					},
					currentPageHeight: {
						'!type': 'number',
						'!doc': ''
					},
					drawDoneEventHandlers: {
						'!type': '[]',
						'!doc': ''
					},
					pageList: {
						'!type': '[]',
						'!doc': ''
					},
					navigationComponents: {
						'!type': '[]',
						'!doc': ''
					},
					pageHeader: {
						'!doc': ''
					},
					pageFooter: {
						'!doc': ''
					},
					pageContainer: {
						'!doc': ''
					},
					exportIFrame: {
						'!doc': ''
					},
					exportForm: {
						'!type': '',
						'!doc': ''
					},
					exportFormInputs: {
						'!doc': ''
					},
					isMobileDeviceFlag: {
						'!type': '?',
						'!doc': ''
					},
					isTouchDeviceFlag: {
						'!type': '?',
						'!doc': ''
					},
					messagePopup: {
						'!type': '',
						'!doc': ''
					},
					contentDrawn: {
						'!type': 'bool',
						'!doc': ''
					},
					editBar: {
						'!doc': ''
					},
					settingsPopup: {
						'!doc': ''
					},
					widgetBar: {
						'!doc': ''
					},
					warningBar: {
						'!doc': ''
					}
				},
				defaultSettings: {
					checkParentWindow: {
						'!type': 'bool',
						'!doc': ''
					},
					pageTransition: {
						'!type': 'string',
						'!doc': '',
						'!data': 'Dashboard.PAGE_TRANSITION'
					},
					zIndex: {
						'!type': 'number',
						'!doc': ''
					},
					parentElement: {
						'!doc': ''
					},
					requestCachingEnabled: {
						'!type': 'bool',
						'!doc': ''
					},
					platform: {
						'!type': 'string',
						'!doc': ''
					}
				},
				PAGE_TRANSITION: {
					FADE: 'string',
					NONE: 'string'
				},
				LAYOUTS: {
					SMALL: 'string',
					DESKTOP: 'string'
				},
				'prototype': {
					'add': {
						'!type': 'fn(component: ?) -> !this',
						'!doc': 'Adds a component to the dashboard.\nCan be either a Page or a PageHeader.\nA Page will be added to the pages of this dashboard.\nA PageHeader will be set as the PageHeader for this dashboard (only one PageHeader can be set).\n\n@param {}  component <Page/PageHeader> - The component to add\n\n@returns {_DP.ComponentTypes.Dashboard} This object'
					},
					'getPages': {
						'!type': 'fn() -> !this.pages',
						'!doc': 'Returns an array containing all the pages in this dashboard.\n\n@returns {array} An array of Page objects'
					},
					'draw': {
						'!type': 'fn(parentNode: ?) -> !this.DOMElement',
						'!doc': 'Draws the dashboard.\n\n@param {HTMLElement} parentElement (optional) The element to draw the dashboard in\n\n@returns {HTMLElement} The dashboard\'s outer DOM element'
					},

					'getPageCount': {
						'!type': 'fn() -> !this.pages.length',
						'!doc': 'Returns the number of pages in this dashboard.\n\n@returns {integer} The number of pages'
					},
					'getCurrentPage': {
						'!type': 'fn() -> !this.pages.<i>',
						'!doc': 'Returns the Page object of the currently selected page.\n\n@returns {Page} The Page object of the current page'
					},
					'nextPage': {
						'!type': 'fn() -> !this',
						'!doc': 'Increases the page number by 1 if possible and navigates to this page.\n\n@returns {_DP.ComponentTypes.Dashboard} This object'
					},
					'previousPage': {
						'!type': 'fn() -> !this',
						'!doc': 'Decreases the page number by 1 if possible and navigates to this page.\n\n@returns {_DP.ComponentTypes.Dashboard} This object'
					},
					'gotoPageNumber': {
						'!type': 'fn(pageNr: number, callback: ?) -> !this',
						'!doc': 'Navigates to the specified page number.\nIf a callback function or function name is passed, this will be called after navigation is complete.\n\n@param {number} pageNr The number of the page to navigate to callback <function/string> - (optional) The function or name of the function to call once navigation is complete\n\n@returns {_DP.ComponentTypes.Dashboard} This object'
					},
					'gotoPage': {
						'!type': 'fn(pageId: string, callback: ?) -> !this',
						'!doc': 'Navigates to the specified page ID.\nIf a callback function or function name is passed, this will be called after navigation is complete.\n\n@param {string} pageId The ID of the page to navigate to callback <function/string> - (optional) The function or name of the function to call once navigation is complete\n\n@returns {_DP.ComponentTypes.Dashboard} This object'
					},
					'getPageList': {
						'!type': 'fn() -> !this.pageList',
						'!doc': 'Returns an array containing the IDs of all the pages in this dashboard.\n\n@returns {array} An array of page IDs'
					},
					'getPageById': {
						'!type': 'fn(id: string) -> !this.pages.<i>',
						'!doc': 'Returns the page with the given ID.\n\n@param {string} id The ID of the page\n\n@returns {Page} The Page object with the given ID (or null if a page with that ID does not exist)'
					},
					'update': {
						'!type': 'fn() -> ?',
						'!doc': 'Updates the dashboard\'s data based on the current or provided input settings.\n\n@param {object} inputSettings (optional) An object containing input settings to use when retrieving data\n\n@returns {_DP.ComponentTypes.Dashboard} This object'
					},
					'copy': {
						'!type': 'fn() -> Dashboard.prototype.copy.!ret',
						'!doc': 'Creates an identical copy of this object with no references to the original.\nAlso creates copies of all its components.\n\n@returns {_DP.ComponentTypes.Dashboard} A copy of this object'
					},
					'addDrawDoneEventHandler': {
						'!type': 'fn(handler: ?) -> !this',
						'!doc': 'Adds an event handler to be called each time the dashboard is done drawing itself.\nIt is fired each time the dashboard finishes drawing a page and again whenever drawing the page\'s contents is completed.\n\n@param {}  handler <function/string> - The function or name of the function to call\n\n@returns {_DP.ComponentTypes.Dashboard} This object'
					},

					'getWindow': {
						'!type': 'fn() -> ?',
						'!doc': 'Returns the dashboard\'s window DOM object.\nWhen the dashboard is inside an iframe, based on the checkParentWindow setting, it returns either the parent window (default) or the current window.\n\n@returns {DOMWindow} The window object of the window that contains the dashboard'
					},
					'getParentWindow': {
						'!type': 'fn() -> ?',
						'!doc': 'Returns the dashboard\'s parent window.\nThis is the window which contains the iframe which contains the dashboard.\nIf no such window exists (the dashboard is not in an iframe) it returns the current window.\n\n@returns {DOMWindow} The dashboard\'s parent window'
					},
					'getUsesIframe': {
						'!type': 'fn() -> bool',
						'!doc': 'Returns whether the dashboard is contained within an iframe or not.\n\n@returns {boolean} True if the dashboard is within an iframe, false otherwise'
					},
					'getCheckParentWindow': {
						'!type': 'fn() -> bool',
						'!doc': 'Returns whether checking for a parent window when referencing the current window is enabled.\nWhen the dashboard is shown inside an iframe, this determines whether the current window should refer to the parent window (true) or the dashboard window inside the iframe (false).\n\n@returns {boolean} Whether checking for a parent window is enabled'
					},
					'setCheckParentWindow': {
						'!type': 'fn(checkParentWindow: bool) -> !this',
						'!doc': 'Specifies whether to check for a parent window when referencing the current window or not.\nWhen the dashboard is shown inside an iframe, this determines whether the current window should refer to the parent window (true) or the dashboard window inside the iframe (false).\n\n@param {boolean} checkParentWindow Whether to check for a parent window\n\n@returns {_DP.ComponentTypes.Dashboard} This object'
					},
					'updateUrlBookmark': {
						'!type': 'fn() -> !this',
						'!doc': 'Sets the url hash to the current page\'s id\n\n@returns {_DP.ComponentTypes.Dashboard} This object'
					},
					'setInitialPageNumber': {
						'!type': 'fn() -> !this',
						'!doc': 'Sets the initial page number according to the url hash\n\n@returns {_DP.ComponentTypes.Dashboard} This object'
					},
					'resetUrlBookmark': {
						'!type': 'fn() -> !this',
						'!doc': 'Clears the url bookmark (hash)\n\n@returns {_DP.ComponentTypes.Dashboard} This object'
					},
					'showCurrentPage': {
						'!type': 'fn() -> !this',
						'!doc': 'Tells the currently selected page to show itself and updates the url hash bookmark\n\n@returns {_DP.ComponentTypes.Dashboard} This object'
					},
					'setPageTransition': {
						'!type': 'fn(transition: string) -> !this',
						'!doc': 'Sets the type of animation to use for the transition between pages.\nPossible values:\n- Dashboard.PAGE_TRANSITION.NONE\n- Dashboard.PAGE_TRANSITION.FADE (the default)\n\n@param {string} transition The type of transition to use\n\n@returns {_DP.ComponentTypes.Dashboard} This object'
					},
					'getPageTransition': {
						'!type': 'fn() -> string',
						'!doc': 'Returns the setting for the type of animation to use for the transition between pages\n\n@returns {string} The current transition type'
					},
					'setZIndex': {
						'!type': 'fn(zIndex: ?) -> !this',
						'!doc': 'Sets the dashboard\'s z-index (the layer in which the dashboard is drawn; higher layers are drawn in front of lower ones).\nSetting the z-index to -1 (the default) causes the dashboard to automatically determine and use the z-index necessary to be in the front-most layer.\n\n@param {numeric} zIndex A positive integer specifying the z-index for the dashboard\n\n@returns {_DP.ComponentTypes.Dashboard} This object'
					},
					'getZIndex': {
						'!type': 'fn() -> ?',
						'!doc': 'Returns the dashboard\'s z-index (the layer in which the dashboard is drawn; higher layers are drawn in front of lower ones).\nA value of -1 (the default) means the dashboard is shown in the front-most layer (highest found z-index + 1).\n\n@returns {numeric} A positive integer specifying the z-index for the dashboard'
					},
					'bringToFront': {
						'!type': 'fn() -> ?',
						'!doc': 'If the dashboard is contained in an iframe, this sets the iframe\'s z-index to the value of the zIndex setting.\nIf the zIndex setting is set to -1, it sets the iframe to the front-most layer (highest found z-index + 1).\n\n@returns {_DP.ComponentTypes.Dashboard} This object'
					},
					'preloadImage': {
						'!type': 'fn(imageFile: ?)',
					},
					'showLoading': {
						'!type': 'fn() -> !this',
						'!doc': 'Shows a loading image when the dashboard starts\n\n@returns {_DP.ComponentTypes.Dashboard} this dashboard'
					},
					'hideLoading': {
						'!type': 'fn() -> !this',
						'!doc': 'Hides the loading indicator and fades in the dashboard if required, using a transition\n\n@returns {_DP.ComponentTypes.Dashboard} this dashboard'
					},
					'setLoadingMessage': {
						'!type': 'fn(message: string) -> !this',
						'!doc': 'Sets the message into/as a child of the P DOM element displaying the loading indicator message.\n\n@param {string} message The message to have shown by the loading indicator\n\n@returns {_DP.ComponentTypes.Dashboard} This object'
					},
					'showLoadingProgress': {
						'!type': 'fn(progress: string|number, message: string) -> !this',
						'!doc': 'Creates, if not yet created, and shows the loading indicator and the progress indicator as part of it, respectively.\n\n@param {number} progress The percentage to show and represent by filling in the colors of the progress indicator\n@param {string} message (optional) The message to have shown by the progress indicator\n\n@returns {_DP.ComponentTypes.Dashboard} This object'
					},
					'setPageHeader': {
						'!type': 'fn(pageHeader: ?) -> !this',
					},
					'setPageFooter': {
						'!type': 'fn(pageFooter: ?) -> !this',
					},
					'getPopup': {
						'!type': 'fn(popupId: string) -> !this._globalPopups.<i>',
						'!doc': 'Returns the global popup associated with the given popupId\n\n@param {string} popupId The componentId of the popup to return\n\n@returns {_DP.ComponentTypes.Popup} The requested popup'
					},
					'trackPageView': {
						'!type': 'fn(extra?: string) -> !this',
						'!doc': 'Tracks a page view to Google Analytics and to TrackJS\n\n@param {string} [extra] Extra info about the page view\n\n@returns {object} self'
					},
					'updateNavigation': {
						'!type': 'fn()',
					},
					'downloadFile': {
						'!type': 'fn(url: ?)',
					},
					'drawContentDone': {
						'!type': 'fn()',
					},
					'resizeIframe': {
						'!type': 'fn() -> !this',
						'!doc': 'Resizes the iframe (if there is one) according to Dashboard\'s height\n\n@returns {_DP.ComponentTypes.Dashboard} This object'
					},
					'isMobileDevice': {
						'!type': 'fn() -> !this.isMobileDeviceFlag',
						'!doc': '@deprecated Use isTouchDevice\n@returns {boolean}'
					},
					'isTouchDevice': {
						'!type': 'fn() -> !this.isTouchDeviceFlag',
						'!doc': 'Detects a \'touch screen\' device\n@returns {boolean}'
					},
					'showMessage': {
						'!type': 'fn(msg: ?)',
					},
					'addPage': {
						'!type': 'fn(page: Dashboard.pages.<i>) -> !this',
					},
					'isReady': {
						'!type': 'fn() -> bool',
					},
					'remove': {
						'!type': 'fn(page: ?) -> !this',
					},
					'dragWidget': {
						'!type': 'fn(e: ?, el: ?, placeholder: ?, target: ?) -> !3',
					},
					'addNavigationComponent': {
						'!type': 'fn(component: ?) -> !this',
					},
					'toggleEditMode': {
						'!type': 'fn() -> !this',
					},
					'getSettingsPopup': {
						'!type': 'fn() -> !this.settingsPopup',
					},
					'editModeSupported': {
						'!type': 'fn() -> bool',
					},
					'createEditBar': {
						'!type': 'fn() -> Dashboard.editBar',
					},
					'createWidgetBar': {
						'!type': 'fn() -> Dashboard.widgetBar',
					},
					'toggleWidgetBar': {
						'!type': 'fn(show: ?) -> !this',
					},
					'showNotification': {
						'!type': 'fn(options?: ?|string) -> !this',
						'!doc': 'Shows a notification to the user.\n\n@param {object|string} [options] Either an object containing options or a string which will be used as the notification text\n@config {string} [title=\'\'] The title of the notification\n@config {string} [text=\'\'] The notification text\n@config {boolean} [sticky=false] Whether the notification will remain on the screen until closed by the user\n@config {number} [time=5000] The amount of milliseconds the notification will remain on the screen\n@config {string} [type=_DP.ComponentTypes.Notification.NOTIFICATION_TYPE.INFORMATION] The type of notification\n\n@returns {_DP.ComponentTypes.Dashboard} This object'
					},
					'toggleWarningBar': {
						'!type': 'fn(show?: bool) -> !this',
						'!doc': '@param {boolean} [show] Whether to show warning bar. If omitted it will toggle.\n\n@returns {_DP.ComponentTypes.Dashboard} This object'
					},
					'showWarningBar': {
						'!type': 'fn() -> !this',
						'!doc': 'Shows warning bar\n\n@returns {_DP.ComponentTypes.Dashboard}'
					},
					'hideWarningBar': {
						'!type': 'fn() -> !this',
						'!doc': 'Hides warning bar\n\n@returns {_DP.ComponentTypes.Dashboard}'
					},
					'undraw': {
						'!type': 'fn() -> ?',
						'!doc': 'Undraws the dashboard\n\n@augments _DP.ComponentTypes.DashboardComponent#draw\n\n@returns {_DP.ComponentTypes.Dashboard} This object'
					},
					'saveDefinition': {
						'!type': 'fn(message?: string) -> !this',
						'!doc': 'Saves the entire editMode definition of the dashboard using _DP.Engine.saveDefinition\n\n@param {string} [message=\'\'] The message to include in the metadata for this modification\n\n@returns {_DP.ComponentTypes.Dashboard} This object'
					}
				}
			},

			DateInput: {
				'!proto': 'TextInput',
				properties: {
					datePicker: {
						'!doc': ''
					},
					min: {
						'!type': 'string',
						'!doc': ''
					},
					max: {
						'!type': 'string',
						'!doc': ''
					},
					inputType: {
						'!type': 'string',
						'!doc': ''
					},
					datetimeEnabled: {
						'!type': 'bool',
						'!doc': ''
					},
					showMinute: {
						'!type': 'bool',
						'!doc': ''
					},
					changed: {
						'!type': 'bool',
						'!doc': ''
					},
					calendarElement: {
						'!doc': ''
					},
					calendarActive: {
						'!type': 'bool',
						'!doc': ''
					}
				},
				'prototype': {
					'draw': {
						'!type': 'fn(parentNode: ?) -> ?',
						'!doc': 'Draws the DateInput in its parent node and adds the appropriate event handlers\n\n@param {HTMLElement} parentNode The node to draw itself in\n\n@returns {HTMLElement} This object\'s outer DOM element'
					},
					'setValue': {
						'!type': 'fn(value: string) -> !this',
					},
					'getValue': {
						'!type': 'fn()',
					},
					'showCalendar': {
						'!type': 'fn() -> !this',
						'!doc': 'Shows the calendarElement\n\n@returns {_DP.ComponentTypes.DateInput} This object'
					},
					'createCalendar': {
						'!type': 'fn() -> !this',
						'!doc': 'Creates the calendarElement and its event handlers, and appends the element to the body DOMElement\n\n@returns {_DP.ComponentTypes.DateInput} This object'
					},
					'undraw': {
						'!type': 'fn() -> !this',
					}
				}
			},

			DateTimeInput: {
				'!proto': 'TextInput',
				properties: {
					datePicker: {
						'!doc': ''
					},
					min: {
						'!type': 'number',
						'!doc': ''
					},
					max: {
						'!type': 'number',
						'!doc': ''
					},
					datetimeEnabled: {
						'!type': 'bool',
						'!doc': ''
					},
					showMinute: {
						'!type': 'bool',
						'!doc': ''
					},
					changed: {
						'!type': 'bool',
						'!doc': ''
					},
					calendarElement: {
						'!doc': ''
					},
					calendarActive: {
						'!type': 'bool',
						'!doc': ''
					}
				},
				'prototype': {
					'draw': {
						'!type': 'fn(parentNode: ?) -> ?',
						'!doc': 'Draws the DateTimeInput in its parent node and adds the appropriate event handlers\n\n@param {HTMLElement} parentNode The node to draw itself in\n\n@returns {HTMLElement} This object\'s outer DOM element'
					},
					'setValue': {
						'!type': 'fn(value: number) -> !this',
					},
					'getValue': {
						'!type': 'fn() -> !this.value',
					},
					'showCalendar': {
						'!type': 'fn()',
					},
					'createCalendar': {
						'!type': 'fn()',
					}
				}
			},

			DropdownSelector: {
				'!proto': 'InputWidget',
				properties: {
					hasHeader: {
						'!type': 'bool',
						'!doc': ''
					},
					hasResetButton: {
						'!type': 'bool',
						'!doc': ''
					},
					hasSettingsButton: {
						'!type': 'bool',
						'!doc': ''
					},
					hasPopup: {
						'!type': 'bool',
						'!doc': ''
					},
					selectedValue: {
						'!doc': ''
					},
					selectedOption: {
						'!doc': ''
					}
				},
				'prototype': {
					'draw': {
						'!type': 'fn()',
						'!doc': 'DropdownSelector.prototype = new Super();\nDropdownSelector.prototype.constructor = DropdownSelector;'
					},
					'getOptionText': {
						'!type': 'fn(value: ?)',
					},
					'getSelectedOption': {
						'!type': 'fn() -> !this.selectedOption',
						'!doc': 'Returns the selected option: {value:\'\', label: \'\'}\n\n@returns {object} An object containing the label and value of the selected item'
					},
					'getValue': {
						'!type': 'fn()',
					},
					'drawContent': {
						'!type': 'fn()',
					},
					'setValue': {
						'!type': 'fn(value: ?) -> !this',
						'!doc': 'Assigns a new value to the DropdownSelector\n\n@param {*} value The new value\n\n@returns {_DP.ComponentTypes.DropdownSelector} This object'
					}
				}
			},

			FileSelector: {
				'!proto': 'Control',
				properties: {
					form: {
						'!doc': ''
					},
					category: {
						'!type': 'number',
						'!doc': ''
					},
					pageIdString: {
						'!type': 'string',
						'!doc': ''
					},
					iFrame: {
						'!doc': ''
					},
					onComplete: {
						'!doc': ''
					},
					fileName: {
						'!type': 'string',
						'!doc': ''
					},
					fileType: {
						'!type': 'string',
						'!doc': ''
					},
					formVariable: {
						'!type': 'string',
						'!doc': ''
					},
					input: {
						'!doc': ''
					},
					fileNameInput: {
						'!doc': ''
					},
					targetPath: {
						'!doc': ''
					}
				},
				'prototype': {
					'setCategory': {
						'!type': 'fn(category: number) -> !this',
						'!doc': '@param {number} category The category to set\n\n@returns {_DP.ComponentTypes.FileSelector} The FileSelector whose category property has been set'
					},
					'setPageIdString': {
						'!type': 'fn(pageIdString: string) -> !this',
						'!doc': 'Setter for the page ID string\n\n@param {string} pageIdString unique Module identifier\n\n@returns {_DP.ComponentTypes.FileSelector} The FileSelector whose page ID string has been set'
					},
					'draw': {
						'!type': 'fn(parentNode: ?) -> ?',
						'!doc': 'Creates the iframe and form elements used in submitting data for the file upload\n\n@param {Element} parentNode The parent node\n\n@returns {Element} Container DIV with form element'
					},
					'setFormVariable': {
						'!type': 'fn() -> !this',
					},
					'createDOMElement': {
						'!type': 'fn(type: string, attributes: ?|?)',
					},
					'getFile': {
						'!type': 'fn() -> !this.input',
					},
					'setOnComplete': {
						'!type': 'fn(completeHandler: ?) -> !this',
					},
					'submit': {
						'!type': 'fn() -> !this',
					},
					'setFileName': {
						'!type': 'fn(fileName: ?) -> !this',
					},
					'reset': {
						'!type': 'fn() -> !this',
					},
					'setFileType': {
						'!type': 'fn(fileType: ?) -> !this',
					},
					'setTargetPath': {
						'!type': 'fn(targetPath: string) -> !this',
						'!doc': 'Setter for the target path. Prepends a slash if string argument doesn\'t start with one.\n\n@param {string} targetPath The target path to be set as target path\n\n@returns {_DP.ComponentTypes.FileSelector} The FileSelector whose target path is set'
					},
					'getTargetPath': {
						'!type': 'fn() -> !this.targetPath',
						'!doc': 'Getter for the target path. Default is \'/\'\n\n@returns {string} The target path'
					},
					'getSelectedFileName': {
						'!type': 'fn()',
					}
				}
			},

			FileUploader: {
				'!proto': 'Widget',
				properties: {
					category: {
						'!type': 'number',
						'!doc': ''
					},
					pageIdString: {
						'!type': 'string',
						'!doc': ''
					},
					onComplete: {
						'!doc': ''
					},
					label: {
						'!type': 'string',
						'!doc': ''
					},
					onUpload: {
						'!doc': ''
					},
					fileType: {
						'!type': 'string',
						'!doc': ''
					},
					targetPath: {
						'!doc': ''
					},
					validators: {
						'!type': '[]',
						'!doc': 'A collection of validator functions for the file name input, of form: {validator: function, message: string}'
					},
					fileSelector: {
						'!type': 'FileSelector',
						'!doc': '_DP.ComponentTypes.FileSelector'
					},
					fileNameInput: {
						'!type': 'TextInput',
						'!doc': '_DP.ComponentTypes.TextInput'
					}
				},
				'prototype': {
					'upload': {
						'!type': 'fn() -> !this',
						'!doc': 'Starts the upload, provided that the file name input and file selector validate\n\n@returns {_DP.ComponentTypes.FileUploader} This object'
					},
					'add': {
						'!type': 'fn(component: ?)',
					},
					'reset': {
						'!type': 'fn() -> !this',
					},
					'getFile': {
						'!type': 'fn()',
					},
					'getSelectedFileName': {
						'!type': 'fn()',
					}
				}
			},

			GeoChart: {
				'!proto': 'OutputWidget',
				properties: {
					shapeColor: {
						'!type': 'string',
						'!doc': "Default color code for the shapes, defaults to 'ffffff'"
					},
					mapOptions: {
						'!doc': 'Specified map options (Google API format), defaults to {}'
					},
					updateTimeout: {
						'!type': 'number',
						'!doc': 'Value in seconds after which the widget will update itself if autoUpdate is enabled, defaults to 0'
					},
					autoUpdate: {
						'!type': 'bool',
						'!doc': 'Whether or not the widget should auto update itself, defaults to false'
					},
					mapType: {
						'!type': 'string',
						'!doc': 'Default map type google.maps.MapTypeId.ROADMAP'
					},
					mapTypes: {
						'!type': 'bool',
						'!doc': 'Which maptypes should be shown in googles maptype selector, see https://developers.google.com/maps/documentation/javascript/maptypes'
					},
					fetchingMessage: {
						'!type': 'string',
						'!doc': "The default message to show when updating, automatically translated, defaults to 'Updating...'"
					},
					zoomLevel: {
						'!type': 'number',
						'!doc': 'The initial zoomlevel when loading the widget, defaults to 12'
					},
					minimumZoomLevel: {
						'!type': 'number',
						'!doc': ''
					},
					shapeToMarkerThreshold: {
						'!type': 'number',
						'!doc': ''
					},
					clusterMarkers: {
						'!type': 'bool',
						'!doc': ''
					},
					markerClustererSetAverageCenter: {
						'!type': 'bool',
						'!doc': ''
					},
					fitViewToData: {
						'!type': 'bool',
						'!doc': ''
					},
					clusterIconStyles: {
						'!type': '[]',
						'!doc': ''
					},
					inputSetting: {
						'!type': 'string',
						'!doc': ''
					},
					selectOnClick: {
						'!type': 'bool',
						'!doc': ''
					},
					markerImage: {
						'!type': 'string',
						'!doc': ''
					},
					selectedMarkerImages: {
						'!type': '[]',
						'!doc': ''
					},
					itemStyle: {
						'!doc': ''
					},
					selectedItemStyle: {
						'!doc': ''
					},
					selectedClusterIconStyle: {
						'!doc': ''
					},
					clusterDoubleclickZoomEnabled: {
						'!type': 'bool',
						'!doc': ''
					},
					skipAutoUpdateWhenZoomingIn: {
						'!type': 'bool',
						'!doc': ''
					},
					defaultLocation: {
						'!doc': '{latitude: latitude, longitude: longitude, zoom: zoom}'
					},
					customMapLayouts: {
						'!type': '[]',
						'!doc': "{name: 'GRAYSCALE', style: [{featureType: 'water', stylers: [{ 'lightness': -40 }]}, {featureType: 'all', elementType: 'all', stylers: [{ saturation: -100 }]}], mapoptions: {name: 'Grayscale'}}]"
					}
				},
				defaultSettings: {
					applyOnChange: {
						'!type': 'bool',
						'!doc': ''
					}
				}
			},

			Grid: {
				'!proto': 'InputWidget',
				properties: {
					hasResetButton: {
						'!type': 'bool',
						'!doc': ''
					},
					hasSettingsButton: {
						'!type': 'bool',
						'!doc': ''
					},
					hasPopup: {
						'!type': 'bool',
						'!doc': ''
					},
					handsOnTableOptions: {
						'!doc': 'The options for the jQuery handsontable plugin\nSee https://github.com/warpech/jquery-handsontable/wiki/Options for full details on options',
						'!url': 'https://github.com/warpech/jquery-handsontable/wiki/Options'
					}
				},
				'prototype': {
					'draw': {
						'!type': 'fn() -> ?',
						'!doc': 'Draws the Grid\n\n@returns {_DP.ComponentTypes.Grid} This object'
					},
					'clear': {
						'!type': 'fn() -> !this',
						'!doc': 'Clears the Grid\n\n@returns {_DP.ComponentTypes.Grid} This object'
					},
					'setValue': {
						'!type': 'fn(value: [?]) -> !this',
						'!doc': 'Sets the value of the Grid\nShould be a two dimensional array\nFirst array holds the rows each array item within is an array for the columns\n\n@param {Array}\tvalue\tthe value to set in the Grid\n\n@returns {_DP.ComponentTypes.Grid} This object'
					},
					'getValue': {
						'!type': 'fn() -> ?',
						'!doc': 'Returns the two dimensional array holding the values of the Grid\n\n@returns {_DP.ComponentTypes.Grid} This object'
					}
				}
			},

			HarveyBall: {
				'!proto': 'Control',
				properties: {
					max: {
						'!type': 'number',
						'!doc': 'Determines the maximum value, which represents a completely filled circle.'
					},
					steps: {
						'!type': 'number',
						'!doc': 'Defaults to 4'
					},
					color: {
						'!type': 'string',
						'!doc': "The color used to draw the Harvey Ball. Defaults to '#676767'."
					},
					backgroundColor: {
						'!type': 'string',
						'!doc': 'The background color of the Harvey Ball. Defaults to (transparent).'
					},
					animate: {
						'!type': 'bool',
						'!doc': 'Whether the Harvey Ball should be animated. Defaults to true.'
					},
					lineWidth: {
						'!type': 'number',
						'!doc': 'Defaults to 1.25'
					},
					circleStyle: {
						'!type': 'string',
						'!doc': 'Defaults to Harvery_ball',
						'!data': 'HarveyBall.CIRCLE_STYLE'
					}
				},
				CIRCLE_STYLE: {
					HARVEY_BALL: 'string',
					CIRCLE: 'string'
				},
				'prototype': {
					'draw': {
						'!type': 'fn() -> ?',
						'!doc': 'Does the initial draw for the harvey ball, creates the canvas and initializes the polyfill if needed\n\n@returns {HTMLDivElement} The component\'s outer DOM element'
					},
					'updateHarveyBall': {
						'!type': 'fn() -> !this',
						'!doc': 'Handles the updating of the HarveyBall representation. Decides whether to draw the value right away or to animate it\n\n@returns {_DP.ComponentTypes.HarveyBall} This object'
					},
					'setValue': {
						'!type': 'fn(value: number) -> !this',
						'!doc': 'Handles the updating of the HarveyBall value. If drawn calls updateHarveyBall to update representation\n\n@param {number} value The new value\n\n@returns {_DP.ComponentTypes.HarveyBall} This object'
					},
					'getMax': {
						'!type': 'fn() -> !this.max',
						'!doc': 'Returns the Max of the HarveyBall.\n\n@returns {Number} The max of the HarveyBall'
					},
					'setMax': {
						'!type': 'fn(max: number) -> !this',
						'!doc': 'Handles the updating of the HarveyBall max. If drawn calls updateHarveyBall to update representation\n\n@param {number} max The new max\n\n@returns {_DP.ComponentTypes.HarveyBall} This object'
					},
					'getCircleStyle': {
						'!type': 'fn() -> !this.circleStyle',
						'!doc': 'Returns the circle style of the HarveyBall.\n\n@returns {string} The current circle style'
					},
					'setCircleStyle': {
						'!type': 'fn(value: number) -> !this',
						'!doc': 'Handles the updating of the HarveyBall circle style. If drawn calls updateHarveyBall to update representation\n\n@param {number} value The new circle mode\n\n@returns {_DP.ComponentTypes.HarveyBall} This object'
					},
					'getSteps': {
						'!type': 'fn() -> !this.steps',
						'!doc': 'Returns the stepSize amount of the HarveyBall.\n\n@returns {Number} The stepSize of the HarveyBall'
					},
					'setSteps': {
						'!type': 'fn(steps: number) -> !this',
						'!doc': 'Handles the updating of the amount of HarveyBall rendering steps. If drawn calls updateHarveyBall to update representation\n\n@param {number} steps The new number of steps\n\n@returns {_DP.ComponentTypes.HarveyBall} This object'
					},
					'stop': {
						'!type': 'fn() -> ?',
						'!doc': 'Stops any animation running on the HarveyBall\n\n@returns {_DP.ComponentTypes.HarveyBall} This object'
					},
				}
			},

			Highchart: {
				'!proto': 'OutputWidget',
				properties: {
					contentId: {
						'!type': 'string',
						'!doc': ''
					},
					contentElement: {
						'!doc': ''
					},
					chart: {
						'!doc': ''
					},
					chartSettings: {
						'!doc': ''
					},
					drilldownSequence: {
						'!type': '[]',
						'!doc': ''
					},
					drilldownBreadcrumbs: {
						'!doc': ''
					},
					drilldownAnalyses: {
						'!type': '[]',
						'!doc': ''
					},
					currentDrilldownLevel: {
						'!type': 'number',
						'!doc': ''
					},
					categoryValues: {
						'!doc': ''
					},
					seriesValues: {
						'!type': '[]',
						'!doc': ''
					},
					legend: {
						'!doc': ''
					},
					inputSetting: {
						'!type': 'string',
						'!doc': ''
					},
					linkBy: {
						'!type': 'string',
						'!doc': 'Defaults to Highchart.LINKBY.CHART',
						'!data': 'Highchart.LINKBY'
					},
					linkValue: {
						'!type': 'string',
						'!doc': 'Defaults to Highchart.LINKVALUE.CATEGORY',
						'!data': 'Highchart.LINKVALUE'
					},
					selectedSeries: {
						'!type': 'number',
						'!doc': ''
					},
					clickedGraphSegment: {
						'!doc': ''
					},
					chartType: {
						'!type': 'string',
						'!doc': ''
					},
					allowMultipleSelections: {
						'!type': 'bool',
						'!doc': ''
					},
					allowClickAnywhere: {
						'!type': 'bool',
						'!doc': ''
					}
				},
				defaultSettings: {
					chartNoDataMessage: {
						'!type': 'string',
						'!doc': "Message to show when there's no data, defaults to 'This chart has no data. Please check your filter.'"
					},
					toggleSeriesByLegend: {
						'!type': 'bool',
						'!doc': 'Whether to allow toggling of series by clicking on their legend'
					},
					highchartReverseBarChartSeries: {
						'!type': 'bool',
						'!doc': ''
					},
					outputWidgetExportOptions: {
						'!type': '[]',
						'!doc': "Available export options, defaults to [{value: 'image/png', label: 'Image (PNG)', inputType: 'SVG'}, {value: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', label: 'PowerPoint', inputType: 'SVG'}, {value: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', label: 'Excel', inputType: 'JSON'}]"
					}
				},
				LINKVALUE: {
					NONE: 'number',
					CATEGORY: 'number',
					SERIES: 'number'
				},
				LINKBY: {
					NONE: 'number',
					CHART: 'number',
					LEGEND: 'number',
					WIDGET: 'number',
					TITLE: 'number'
				},
				CHART_TYPE: {
					CHART: 'string',
					RADAR: 'string'
				},
				'prototype': {
					'EVENT_CATEGORY': {
						'!type': 'string',
						'!doc': 'Highchart.prototype = new Super();\nHighchart.prototype.constructor = Highchart;'
					},
					'reflow': {
						'!type': 'fn() -> !this',
						'!doc': 'Calls reflow on the inner Highchart component\n\n@returns {_DP.ComponentTypes.Highchart} This object'
					},
					'draw': {
						'!type': 'fn() -> ?',
						'!doc': 'Draws the highchart widget.\n\n@augments _DP.ComponentTypes.OutputWidget#draw\n\n@returns {HTMLDivElement} The body element of the widget'
					},
					'drawContent': {
						'!type': 'fn() -> !this',
						'!doc': 'Renders the Highchart, based on the chartSettings and data.\n\n@returns {_DP.ComponentTypes.Highchart} This object'
					},
					'hasData': {
						'!type': 'fn() -> bool',
					},
					'createChart': {
						'!type': 'fn() -> !this',
						'!doc': 'Creates the highchart instance and sets instance\'s child to this one\n\n@returns {_DP.ComponentTypes.Highchart} This object'
					},
					'setCategories': {
						'!type': 'fn(categories: ?) -> !this',
						'!doc': 'Sets the categories (x-axis ticks).\n\n@param {object} categories An indexed array of strings, containing labels for the x-axis ticks.\n\n@returns {_DP.ComponentTypes.Highchart} This object'
					},
					'drillDown': {
						'!type': 'fn(categoryTitle: string, seriesIndex: number, categoryValue: string, seriesSettings: ?) -> !this',
						'!doc': 'Drills down to the next drilldown level, if a drilldown sequence is defined.\n\n@param {string} categoryTitle The title of the category that will be drilled in to.\n@param {number} seriesIndex The index of the serie that will be drilled in to.\n@param {string} categoryValue (Optional) The value of the category corresponding to categoryTitle. Will be filled based on the categoryValues property if omitted.\n@param {object} serieSettings (Optional) Drilldown settings based on the serie that is being drilled in to. Will be filled based on the seriesSettings of the current level in the drilldownSequence if omitted.\n\n@returns {_DP.ComponentTypes.Highchart} This object'
					},
					'drillTo': {
						'!type': 'fn(level: number)',
						'!doc': 'Drills to a specific level in the drilldown sequence, provided that the settings for this level have already been compiled by the drillTo method.\n\n@param {number} level The level in the drilldownSequence to drill to.\n\n@returns {_DP.ComponentTypes.Highchart} This object'
					},
					'setCategoryValues': {
						'!type': 'fn(categoryValues: ?) -> !this',
						'!doc': 'Sets an array of category values.\nSelecting a category will set the value of this component to the value in this array corresponding to the index of\nthe selected category, provided that linkValue is set to CATEGORY.\nThe length of the array should correspond to the number of categories.\nNote: The argument can also be an object of key-value pairs mapping category labels to values, but this usage is\ndeprecated.\n\n@param {}  categoryValues <Array>/<object> - An array of category values, or an object mapping category labels to values (deprecated)\n\n@returns {_DP.ComponentTypes.Highchart} This object'
					},
					'addDrilldownCrumb': {
						'!type': 'fn(level: number) -> !this',
						'!doc': 'Adds a breadcrumb to the linked Breadcrumbs widget, based on a level in the drilldownSequence.\n\n@param {number} level The level in the drilldownSequence that contains the settings used for the breadcrumb.\n\n@returns {_DP.ComponentTypes.Highchart} This object'
					},
					'updateDrilldownCrumb': {
						'!type': 'fn(level: number, title: string) -> !this',
						'!doc': 'Updates the name of a breadcrumb in the linked Breadcrumbs widget.\n\n@param {number} level The index of the breadcrumb. Corresponds to the drilldown level.\n@param {string} title The new label for the breadcrumb.\n\n@returns {_DP.ComponentTypes.Highchart} This object'
					},
					'setChartSettings': {
						'!type': 'fn(chartSettings: Highchart.prototype.setChartSettings.!0) -> !this',
						'!doc': 'Sets the settings for the Highchart.\nRefer to the Highcharts documentation for details.\n\n@param {object} chartSettings The settings object\n\n@returns {_DP.ComponentTypes.Highchart} This object'
					},
					'getChartSettings': {
						'!type': 'fn() -> !this.chartSettings',
						'!doc': 'Returns the current settings for the Highchart.\n\n@returns {object} The settings object'
					},
					'getDrilldownBreadcrumbs': {
						'!type': 'fn() -> !this.drilldownBreadcrumbs',
						'!doc': 'Returns the Breadcrumbs widget linked to this widget.\nWill check the linkedComponents for the first component that is an instance of Breadcrumbs and will return it if found.\nReturns null if none is found.\n\n@returns {Breadcrumbs} The linked Breadcrumbs widget.'
					},
					'addDrilldownLevel': {
						'!type': 'fn(settings: Highchart.drilldownSequence.<i>) -> !this',
						'!doc': 'Adds a level to the end of the drilldown sequence.\nThe behaviour of the drilldown is determined by a number of settings, one or more can be used.\nNOTE: Drilldown settings which modify the datarequest are currently only supported for getCrosstab datarequests.\nThe following settings are supported:\n* label                 <string>  Specifies the label for the drilldown level.\n* componentId           <string>  Specifies another Highchart widget. Drilling to this level will defer the drilldown to that widget, show it and hide this one.\n* variable              <string>  Specifies a variable to use for filtering and comparing the data. It will function as compare variable for the level being drilled to and as as filter variable for the next level, similar to the two settings described below. When using this setting, the settings filterVariable and compareVariable are ignored.\n* filterVariable        <string>  Specifies a variable for filtering the data when drilling to this level. The filterstring of the datarequest will be extended with a condition of the form \' AND [filterVariable] = [categoryValue]\'\n* compareVariable       <string>  Specifies a variable to seperate the data on when drilling to this level. This variable will be set as the column variable of the datarequest.\n* updateBreadcrumbLabel <boolean> Specifies whether to update the breadcrumb label of the current level when drilling to the next level. The label of the breadcrumb will be changed to the categoryTitle corresponding to the selected category.\n* updateWidgetTitle     <boolean> Specifies whether to update the title of the widget to the selected category title of the previous level when drilling to this level.\n* seriesSettings        <object>  An array containing settings specific to the series that was selected in this level. The key of the array is the index of the series. The value is an object with one or more of the following settings:\n* label         <string> An addition label that will be appended to the widget title when drilling in to this series.\n* answers       <object> An indexed array containing answer codes (as strings) which will be set as the \'aggregatedAnswers\' setting when drilling in to this series and can be passed to the dataprocessor.\n* chartSettings <object> An object of Highcharts settings which will be applied to the widget as chartSettings when drilling in to this series.\n\n@param {object} settings An object containing settings for the drilldown level\n\n@returns {_DP.ComponentTypes.Highchart} This object'
					},
					'setSeriesValues': {
						'!type': 'fn(seriesValues: ?) -> !this',
					},
					'getSeriesValue': {
						'!type': 'fn(seriesIndex: number) -> !this.seriesValues.<i>',
					},
					'getCategoryValue': {
						'!type': 'fn(category: number) -> !this._categoryValues.<i>',
					},
					'email': {
						'!type': 'fn(format: string, address: string, body: string, ccYourself: bool, options?: ?) -> !this',
						'!doc': 'Sends an export request, relaying the format, address, body and whether to CC the user, based on user input, and sending the data to be exported, based on the format requested, along with the request.\nThe actual format of the data send with the request is either SVG or JSON. Which is to be used is dependent on the export options retrieved via this.getExportOptions.\nThe method returns the component unchanged and works by virtue of side-effects only: this.submitExportRequest updates the DOM.\n\n@param {string} format The MIME Content Type used to decide what data to retrieve.\n@param {string} address An e-mail address.\n@param {string} body The body passed as the e-mail body to this.submitExportRequest.\n@param {boolean} ccYourself Whether to CC the user.\n@param {object} [options] Additional chart options for exporting\n@config {object} [svg] Additional options for the SVG conversion\n@config {object} [export] Additional options for the back-end export interface\n\n@returns {_DP.ComponentTypes.Highchart} This object'
					},
					'download': {
						'!type': 'fn(format: string, options?: ?) -> !this',
						'!doc': 'Sends an export request, relaying the format, based on user input, and sending the data to be exported, based on the format requested, along with the request.\nThe actual format of the data send with the request is either SVG or JSON. Which is to be used is dependent on the export options retrieved via this.getExportOptions.\nThe method returns the component unchanged and works by virtue of side-effects only: this.submitExportRequest updates the DOM.\n\n@param {string} format The MIME Content Type used to decide what data to retrieve.\n@param {object} [options] Additional exporting options\n@config {object} [svg] Additional options for the SVG conversion\n@config {object} [export] Additional options for the back-end export interface\n\n@returns {_DP.ComponentTypes.Highchart} This object'
					},
					'toJSON': {
						'!type': 'fn() -> Highchart.prototype.toJSON.!ret',
					},
					'getValue': {
						'!type': 'fn()',
					},
					'applyDimensions': {
						'!type': 'fn() -> ?',
						'!doc': 'Applies the component\'s width and height to its DOM element, then re-renders the chart\n\n@augments _DP.ComponentTypes.DashboardComponent#applyDimensions\n\n@returns {_DP.ComponentTypes.DashboardComponent}'
					},
					'setColors': {
						'!type': 'fn(colors: ?) -> !this',
					},
					'getCategoryValues': {
						'!type': 'fn() -> !this._categoryValues',
					},
					'getExportData': {
						'!type': 'fn() -> ?',
						'!doc': 'Makes sure that there is a \'categories\' own property of the object with the export data to be sent to the server.\n\n@returns {object} The data to be sent to the server for creation of the file/data to be exported'
					},
					'setData': {
						'!type': 'fn(data: ?) -> !this',
						'!doc': 'Sets the data set for the Highchart\nImplements support for categories inside the data set\n\n@augments _DP.ComponentTypes.Widget#setData\n\n@param {object} data A dataset, or an object containing a categories member and a data member\n\n@returns {_DP.ComponentTypes.Highchart} This object'
					}
				}
			},

			Icon: {
				'!proto': 'Control',
				properties: {
					imageName: {
						'!type': 'number',
						'!doc': 'string'
					},
					imageOffsetX: {
						'!type': 'number',
						'!doc': ''
					},
					imageOffsetY: {
						'!type': 'number',
						'!doc': ''
					},
					imageWidth: {
						'!type': 'number',
						'!doc': ''
					},
					imageHeight: {
						'!type': 'number',
						'!doc': ''
					},
					imageElement: {
						'!doc': ''
					}
				},
				defaultSettings: {
					applyImageColorMask: {
						'!type': 'bool',
						'!doc': ''
					},
					useColor: {
						'!type': 'bool',
						'!doc': ''
					}
				},
				'prototype': {
					'draw': {
						'!type': 'fn()',
						'!doc': 'Icon.prototype = new Super();\nIcon.prototype.constructor = Icon;'
					},
					'setImage': {
						'!type': 'fn(imageName: ?) -> !this',
					},
					'setImageOffset': {
						'!type': 'fn(x: ?, y: ?, width: ?, height: ?)',
					},
					'getImageElement': {
						'!type': 'fn() -> !this.imageElement',
					}
				}
			},

			Image: {
				'!proto': 'Widget',
				properties: {
					imageName: {
						'!type': 'string',
						'!doc': 'imageName'
					},
					imageElement: {
						'!doc': 'imageElement'
					},
					imageOffsetX: {
						'!type': 'number',
						'!doc': 'imageOffsetX'
					},
					imageOffsetY: {
						'!type': 'number',
						'!doc': 'imageOffsetY'
					},
					imageWidth: {
						'!type': 'number',
						'!doc': 'imageWidth'
					},
					imageHeight: {
						'!type': 'number',
						'!doc': 'imageHeight'
					}
				},
				defaultSettings: {
					applyImageColorMask: {
						'!type': 'bool',
						'!doc': 'apply image color mask'
					}
				},
				'prototype': {
					'draw': {
						'!type': 'fn(parentNode: ?)',
						'!doc': 'Image.prototype = new Super();\nImage.prototype.constructor = Image;'
					},
					'setName': {
						'!type': 'fn(imageName: string) -> !this',
						'!doc': 'Sets the name of the image to use.\nThe path is determined by the theme, the extension used is always .png.\n\n@param {string} imageName The name of the image (filename without path and extension)\n\n@returns {_DP.ComponentTypes.Image} This object'
					},
					'setAlwaysColored': {
						'!type': 'fn(alwaysColored: bool) -> !this',
						'!doc': 'Sets whether the image should use its color only when hovering (false) or\nall the time (true).\n\n@param {boolean} alwaysColored Optional. False indicates that the image does not apply its color until the user hovers the mouse over it. True means the button is always colored. If the argument is omitted, True will be used.\n\n@returns {_DP.ComponentTypes.Image} This object'
					}
				}
			},

			InputWidget: {
				'!proto': 'Widget',
				properties: {
					hasHeader: {
						'!type': 'bool',
						'!doc': 'Whether the input widget should show a header'
					},
					hasResetButton: {
						'!type': 'bool',
						'!doc': 'Whether the input widget should show a reset button'
					},
					hasSettingsButton: {
						'!type': 'bool',
						'!doc': 'whether the input widget should show a settings button'
					},
					inputControls: {
						'!type': '[]',
						'!doc': 'a collection of controls that control the input settings of this widget'
					},
					size: {
						'!type': 'string',
						'!doc': ''
					},
					hasPopup: {
						'!type': 'bool',
						'!doc': ''
					},
					inputSetting: {
						'!type': 'string',
						'!doc': ''
					},
					settingsButtonImage: {
						'!type': 'string',
						'!doc': ''
					},
					passDataToControls: {
						'!type': 'bool',
						'!doc': ''
					},
					popup: {
						'!doc': ''
					}
				},
				defaultSettings: {
					inputWidgetClickHeaderForSettings: {
						'!type': 'bool',
						'!doc': ''
					},
					useInputSettings: {
						'!type': 'bool',
						'!doc': ''
					},
					applyOnChange: {
						'!type': 'bool',
						'!doc': ''
					}
				},
				'prototype': {
					'draw': {
						'!type': 'fn()',
						'!doc': '@augments _DP.ComponentTypes.Widget#draw\n\n@see _DP.ComponentTypes.Widget#draw'
					},
					'setData': {
						'!type': 'fn(data: ?)',
					},
					'applyInputSettings': {
						'!type': 'fn(preventUpdate?: bool)',
						'!doc': 'Tells the attached input controls to read and return their set values, then sends\nthese to the linked component, along with a request for update.\n\n@param {boolean} [preventUpdate=false] If the applyInputSettings should use setInputSettings instead of the linkedComponent\'s update method\n\n@returns {} void'
					},
					'setInputSetting': {
						'!type': 'fn(inputSetting: string) -> !this',
						'!doc': 'Tells the input widget which input setting it controls\n\n@param {string} inputSetting The identifier (name) of the input setting\n\n@returns {_DP.ComponentTypes.InputWidget} This object'
					},
					'getInputSetting': {
						'!type': 'fn() -> !this.inputSetting',
						'!doc': 'Returns the input setting controlled by this input widget.\n\n@returns {string} The name of the input setting controlled by this input widget'
					},
					'add': {
						'!type': 'fn(component: InputWidget.popup, draw: ?)',
					},
					'readInputSettings': {
						'!type': 'fn() -> InputWidget.prototype.readInputSettings.!ret',
						'!doc': '@returns {} void'
					},
					'getLinkedComponents': {
						'!type': 'fn() -> !this.linkedComponents',
					},
					'getValue': {
						'!type': 'fn()',
					},
					'setValue': {
						'!type': 'fn(value: ?) -> !this',
					},
					'clear': {
						'!type': 'fn() -> !this',
					},
					'getPopup': {
						'!type': 'fn() -> !this.popup',
					},
					'addInputControl': {
						'!type': 'fn(control: InputWidget.popup) -> !this',
					},
					'setFocus': {
						'!type': 'fn() -> !this',
					}
				}
			},

			Label: {
				'!proto': 'Control',
				properties: {
					text: {
						'!type': 'string',
						'!doc': ''
					},
					alignment: {
						'!type': 'string',
						'!doc': ''
					},
					labelElement: {
						'!doc': ''
					}
				},
				defaultSettings: {
					useColor: {
						'!type': 'bool',
						'!doc': ''
					}
				},
				ALIGNMENT: {
					LEFT: 'string',
					RIGHT: 'string',
					CENTER: 'string'
				},
				'prototype': {
					'draw': {
						'!type': 'fn()',
					},
					'setText': {
						'!type': 'fn(text: ?) -> !this',
					},
					'setAlignment': {
						'!type': 'fn(alignment: ?) -> !this',
					},
					'setWidth': {
						'!type': 'fn(width: ?) -> !this',
					},
					'getWidth': {
						'!type': 'fn() -> !this.width',
					},
					'getLabelElement': {
						'!type': 'fn() -> !this.labelElement',
					}
				}
			},

			Legend: {
				'!proto': 'OutputWidget',
				defaultSettings: {
					columnCount: {
						'!type': 'number',
						'!doc': ''
					}
				},
				properties: {
					legendData: {
						'!type': '[]',
						'!doc': ''
					},
					header: {
						'!type': 'string',
						'!doc': ''
					},
					className: {
						'!type': 'string',
						'!doc': ''
					}
				},
				'prototype': {
					'setColumnCount': {
						'!type': 'fn(columns: ?)',
						'!doc': 'Legend.prototype = new Super();\nLegend.prototype.constructor = Legend;'
					},
					'setData': {
						'!type': 'fn(data: ?) -> !this',
					},
					'getData': {
						'!type': 'fn() -> !this.legendData',
					},
					'getColumnCount': {
						'!type': 'fn()',
					},
					'drawContent': {
						'!type': 'fn() -> !this.bodyDOMElement',
					},
					'addItem': {
						'!type': 'fn(label: ?, color: ?, value: ?, benchmark: ?)',
					},
					'setHeader': {
						'!type': 'fn(headerString: ?)',
					}
				}
			},

			MultiChart: {
				'!proto': 'OutputWidget',
				properties: {
					chartSettings: {
						'!doc': ''
					},
					charts: {
						'!type': '[]',
						'!doc': ''
					},
					scrollable: {
						'!type': 'bool',
						'!doc': ''
					},
					mouseOverScroll: {
						'!type': 'bool',
						'!doc': ''
					}
				},
				'prototype': {
					'draw': {
						'!type': 'fn()',
						'!doc': 'public functions'
					},
					'drawContent': {
						'!type': 'fn()',
					}
				}
			},

			MultiText: {
				'!proto': 'OutputWidget',
				properties: {
					textElements: {
						'!type': '[]',
						'!doc': ''
					},
					text: {
						'!type': 'string',
						'!doc': ''
					},
					textAlignment: {
						'!type': 'string',
						'!doc': ''
					},
					rowLimit: {
						'!type': 'number',
						'!doc': ''
					},
					refreshInterval: {
						'!type': 'number',
						'!doc': ''
					},
					currentDataIndex: {
						'!type': 'number',
						'!doc': ''
					},
					rowElements: {
						'!type': '[]',
						'!doc': ''
					},
					inputSetting: {
						'!type': 'string',
						'!doc': ''
					},
					timer: {
						'!doc': ''
					},
					scrollable: {
						'!type': 'bool',
						'!doc': ''
					},
					pivotExportData: {
						'!type': 'bool',
						'!doc': ''
					},
					rowCache: {
						'!type': '[]',
						'!doc': ''
					}
				},
				defaultSettings: {
					useBackgroundColor: {
						'!type': 'bool',
						'!doc': ''
					}
				},
				'prototype': {
					'draw': {
						'!type': 'fn()',
						'!doc': 'MultiText.prototype = new Super();\nMultiText.prototype.constructor = MultiText;'
					},
					'drawContent': {
						'!type': 'fn()',
					},
					'showNext': {
						'!type': 'fn() -> !this',
					},
					'removeFirst': {
						'!type': 'fn() -> !this',
					},
					'getInputSetting': {
						'!type': 'fn() -> !this.inputSetting',
					},
					'addRow': {
						'!type': 'fn(rowData: ?)',
					},
					'clear': {
						'!type': 'fn()',
					},
					'toJSON': {
						'!type': 'fn()',
					}
				}
			},

			MultiWidget: {
				'!proto': 'OutputWidget',
				properties: {
					// components: {
					// 	'!type': '[]',
					// 	'!doc': ''
					// },
					scrollable: {
						'!type': 'bool',
						'!doc': ''
					}
				},
				defaultSettings: {
					useBackgroundColor: {
						'!type': 'bool',
						'!doc': ''
					}
				},
				'prototype': {
					'draw': {
						'!type': 'fn()',
						'!doc': 'MultiWidget.prototype = new Super();\nMultiWidget.prototype.constructor = MultiWidget;'
					},
					'getExportData': {
						'!type': 'fn() -> [?]',
					}
				}
			},

			Navigation: {
				'!proto': 'Widget',
				properties: {
					pageList: {
						'!doc': ''
					},
					hasHeader: {
						'!type': 'bool',
						'!doc': ''
					},
					listElement: {
						'!doc': ''
					},
					listItemImage: {
						'!type': 'string',
						'!doc': 'Defauls to navigator_item_point'
					},
					imageFile: {
						'!type': 'string',
						'!doc': ''
					},
					hasImage: {
						'!type': 'bool',
						'!doc': ''
					},
					useHoverColor: {
						'!type': 'bool',
						'!doc': ''
					},
					useSelectedcolor: {
						'!type': 'bool',
						'!doc': ''
					},
					lastClickedPageId: {
						'!doc': ''
					}
				},
				defaultSettings: {
					applyImageColorMask: {
						'!type': 'bool',
						'!doc': ''
					},
					navigationEnableMoreTab: {
						'!type': 'bool',
						'!doc': 'Determines whether the \'More\' tab should be created to accommodate menu items that don\'t fit into the view'
					}
				},
				'prototype': {
					'setPageList': {
						'!type': 'fn(pageList: ?) -> !this',
						'!doc': 'Navigation.prototype = new Super();\nNavigation.prototype.constructor = Navigation;'
					},
					'draw': {
						'!type': 'fn()',
					},
					'drawContent': {
						'!type': 'fn()',
					},
					'setListItemImage': {
						'!type': 'fn(imageName: ?)',
					},
					'gotoPage': {
						'!type': 'fn(pageId: string, callback: ?) -> !this',
						'!doc': 'Navigates to the specified page ID.\nEffectively, it calls the gotoPage() method on all linked components.\nIf no linked component has been specifies, this defaults to the dashboard.\nIf a callback function or function name is passed, this will be called after navigation is complete.\n\n@param {string} pageId The ID of the page to navigate to callback <function/string> - (optional) The function or name of the function to call once navigation is complete\n\n@returns {_DP.ComponentTypes.Navigation} This object'
					},
					'undraw': {
						'!type': 'fn() -> ?',
						'!doc': 'Removes resize event handler and calls the parent\'s undraw method.\n\n@augments _DP.ComponentTypes.DashboardComponent#undraw\n\n@returns {_DP.ComponentTypes.Navigation} This object'
					}
				}
			},

			NestedList: {
				'!proto': 'InputWidget',
				properties: {
					scrollable: {
						'!type': 'bool',
						'!doc': 'Whether the list should scroll when the content doesn\'t fit'
					},
					maxLevel: {
						'!type': 'number',
						'!doc': 'The maximum nesting level that will be rendered. -1 is unlimited. 0 is the first level only, etc. '
					},
					redrawOptions: {
						'!type': 'bool',
						'!doc': 'Whether the options should be redrawn on update'
					},
					selectStyle: {
						'!type': 'string',
						'!doc': 'Which method to use for selecting items. See _DP.ComponentTypes.SELECT_STYLE'
					},
					colors: {
						'!type': '[]',
						'!doc': 'A list of colors which will be used for the color boxes when selectStyle is set to colorbox'
					},
					updateFromInputSettings: {
						'!type': 'bool',
						'!doc': 'Whether to visually reflect changes in the inputSettings when updating'
					},
					deselectEnabled: {
						'!type': 'bool',
						'!doc': 'Specifies whether it is possible to deselect an item by clicking on it while it is selected'
					},
					scrollBufferSize: {
						'!type': 'number',
						'!doc': 'When more than zero, only this amount of list items will be rendered initially. The remaining items will be rendered as soon as they are scrolled into view.'
					},
					wrapLabels: {
						'!type': 'bool',
						'!doc': 'Whether the item labels should wrap when they don\'t fit'
					},
					labelWidth: {
						'!type': 'number',
						'!doc': 'If more than zero, labels will not be wider than this'
					},
					componentAlignment: {
						'!type': 'string',
						'!doc': 'Whether item components should be to the left or right of the item label'
					},
					sortable: {
						'!type': 'bool',
						'!doc': 'Whether list items can be dragged to another position in the list'
					},
					orientation: {
						'!type': 'string',
						'!doc': 'Whether the list should be rendered vertically (as a list) or horizontally (as a gallery)'
					},
					tooltipFormatter: {
						'!type': 'fn()',
						'!doc': 'If set, this function will be executed when hovering over an item. It is bound to the Tooltip and receives the item data as its argument. E.g.: function (itemData) {this.setText(itemData.label);}'
					},
					accordionStyle: {
						'!type': 'bool',
						'!doc': 'If true, the nested list will look and behave like an accordion'
					},
					truncateLabels: {
						'!type': 'bool',
						'!doc': 'If true, the labels will be truncated if too long'
					},
					crossdrag: {
						'!type': 'bool',
						'!doc': ''
					},
					persistExpandedItems: {
						'!type': 'bool',
						'!doc': ''
					},
					autoSelectParentItem: {
						'!type': 'bool',
						'!doc': ''
					}
				},
				defaultSettings: {
					nestedListIndentCheckboxes: {
						'!type': 'bool',
						'!doc': ''
					},
					nestedListIndentationWidth: {
						'!type': 'number',
						'!doc': ''
					},
					nestedListExpandButtonWidth: {
						'!type': 'number',
						'!doc': ''
					},
					nestedListShowSelectButtons: {
						'!type': 'bool',
						'!doc': ''
					},
					nestedListShowExpandButtons: {
						'!type': 'bool',
						'!doc': ''
					},
					nestedListShowExpandAllButton: {
						'!type': 'bool',
						'!doc': ''
					},
					nestedListExpandOnLabelClick: {
						'!type': 'bool',
						'!doc': ''
					},
					nestedListSelectOnLabelClick: {
						'!type': 'bool',
						'!doc': ''
					},
					widgetExportOptions: {
						'!type': '[]',
						'!doc': "{value: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', label: 'Excel', inputType: 'JSON'}"
					}
				},
				SELECT_STYLE: {
					CHECKBOX: 'string',
					COLORBOX: 'string',
					LABEL: 'string',
					NONE: 'string',
					EXPAND: 'string',
					RADIOBUTTON: 'string'
				},
				ORIENTATION: {
					VERTICAL: 'string',
					HORIZONTAL: 'string'
				},
				'prototype': {
					'registerDragGroupTarget': {
						'!type': 'fn(remoteComponent: ?) -> !this',
						'!span': '3398[114:22]-3421[114:45]',
						'!doc': 'Registers a remote component as a drop target after dragging is started from this list\n\n@param {DashboardComponent} remoteComponent The component registering as a drop target\n\n@returns {_DP.ComponentTypes.NestedList} This object'
					},
					'draw': {
						'!type': 'fn() -> ?',
						'!span': '4109[144:22]-4113[144:26]',
						'!doc': 'Draws the component\'s DOM elements\n\n@augments _DP.ComponentTypes.InputWidget#draw\n\n@returns {HTMLElement} The component\'s outer DOM element'
					},
					'drawContent': {
						'!type': 'fn() -> !this',
						'!span': '5962[202:22]-5973[202:33]'
					},
					'addList': {
						'!type': 'fn(node: NestedList.prototype.addRow.!ret, listData: [?], level: number, limit: number) -> NestedList.listElement',
						'!span': '17970[572:22]-17977[572:29]'
					},
					'readInputSettings': {
						'!type': 'fn() -> NestedList.prototype.readInputSettings.!ret',
						'!span': '18558[595:22]-18575[595:39]',
						'!doc': 'Returns an inputSettings object containing the settings of this control.\n\n@returns {object} An inputSettings object'
					},
					'populateChildrenByDataRequest': {
						'!type': 'fn(parentElement: NestedList.prototype.addRow.!ret, dataRequest: bool|?)',
						'!span': '20873[666:22]-20902[666:51]'
					},
					'selectAll': {
						'!type': 'fn() -> +NestedList',
						'!span': '22535[720:22]-22544[720:31]',
						'!doc': 'Selects all items\n\n@returns {_DP.ComponentTypes.NestedList} This object'
					},
					'selectNone': {
						'!type': 'fn() -> +NestedList',
						'!span': '22725[729:22]-22735[729:32]',
						'!doc': 'Deselects all items\n\n@returns {_DP.ComponentTypes.NestedList} This object'
					},
					'expandAll': {
						'!type': 'fn(minimize: bool)',
						'!span': '22816[733:22]-22825[733:31]'
					},
					'showSelectedInputSettings': {
						'!type': 'fn(data: ?) -> !this',
						'!span': '23061[743:22]-23086[743:47]'
					},
					'createCheckbox': {
						'!type': 'fn(style: string, checked: bool, color: string, disabled: ?) -> NestedList.prototype.createCheckbox.!ret',
						'!span': '24431[785:22]-24445[785:36]',
						'!doc': 'Creates a checkbox HTML Element\n\n@param {string} style The style of the checkbox (one of the styles in NestedList.SELECT_STYLE)\n@param {bool} checked Whether the checkbox created should be checked or not\n@param {Color} color A color for the checkbox if it is of type \'colorbox\'\n\n@returns {HTML Element} The created checkbox'
					},
					'toggleItem': {
						'!type': 'fn(item: NestedList.prototype.addRow.!ret, select?: bool) -> !this',
						'!span': '26491[855:22]-26501[855:32]',
						'!doc': 'Selects or deselects the given item\n\n@param {Element} item The DOM element representing the item to toggle\n@param {boolean} [select] Whether to select or deselect. When omitted, the current selection state will be toggled.\n\n@returns {_DP.ComponentTypes.NestedList} This object'
					},
					'getSelectedItems': {
						'!type': 'fn(data: ?) -> [!0.<i>]',
						'!span': '29409[955:22]-29425[955:38]'
					},
					'getDataByValue': {
						'!type': 'fn(inputSetting: ?, value: ?, data: ?) -> !2.<i>',
						'!span': '29932[978:22]-29946[978:36]'
					},
					'selectItems': {
						'!type': 'fn(items: [?], selected: bool, selectChildren: bool) -> !this',
						'!span': '31131[1015:22]-31142[1015:33]',
						'!doc': 'Selects or deselects one or multiple items from the nested list\n\nPreconditions:\nThe nested list should have data\nThe nested list have rows\nThe nested list and its content should be drawn\n\n@throws An exception if the items variable is not an array or does not contain any items\n\n@param {Array} items The items to be selected or deselected\n@param {bool} selected Whether to select or deselect the items\n@param {bool} selectChildren Whether to select the children of the given items as well\n\n@returns {_DP.ComponentTypes.NestedList} The instance'
					},
					'setColors': {
						'!type': 'fn(colors: ?) -> !this',
						'!span': '33734[1099:22]-33743[1099:31]'
					},
					'scrollHandler': {
						'!type': 'fn()',
						'!span': '34903[1140:22]-34916[1140:35]'
					},
					'getValue': {
						'!type': 'fn()',
						'!span': '35928[1166:22]-35936[1166:30]'
					},
					'toJSON': {
						'!type': 'fn() -> ?',
						'!span': '36381[1181:22]-36387[1181:28]',
						'!doc': 'Returns the contents of the NestedList in JSON format.\nUsed for sending the formatted data to the backend for exporting and downloading.\n\n@returns {object} A JSON object representing the formatted contents of the NestedList.'
					},
					'listToJSON': {
						'!type': 'fn(list: [?]) -> [NestedList.prototype.listToJSON.!ret.<i>]',
						'!span': '36597[1191:22]-36607[1191:32]'
					},
					'startItemDrag': {
						'!type': 'fn(e: ?) -> bool',
						'!span': '37007[1210:22]-37020[1210:35]'
					},
					'itemDrag': {
						'!type': 'fn(e: ?) -> bool',
						'!span': '39025[1279:22]-39033[1279:30]'
					},
					'stopItemDrag': {
						'!type': 'fn(e: ?) -> bool',
						'!span': '41076[1346:22]-41088[1346:34]'
					},
					'sortData': {
						'!type': 'fn()',
						'!span': '52042[1734:22]-52050[1734:30]'
					},
					'removeItem': {
						'!type': 'fn(value: ?) -> !this',
						'!span': '52526[1753:22]-52536[1753:32]'
					},
					'getDataByItemId': {
						'!type': 'fn(itemId: number, data: ?) -> !1.<i>',
						'!span': '53026[1774:22]-53041[1774:37]'
					},
					'getColors': {
						'!type': 'fn() -> !this.colors',
						'!span': '53512[1796:22]-53521[1796:31]'
					},
					'setScrollable': {
						'!type': 'fn(scrollable: ?) -> !this',
						'!span': '53593[1801:22]-53606[1801:35]'
					},
				}
			},

			Notification: {
				'!proto': 'DashboardComponent',
				properties: {
					title: {
						'!type': 'string',
						'!doc': ''
					},
					text: {
						'!type': 'string',
						'!doc': ''
					},
					sticky: {
						'!type': 'bool',
						'!doc': ''
					},
					time: {
						'!type': 'number',
						'!doc': ''
					},
					notificationType: {
						'!type': 'string',
						'!doc': ''
					}
				},
				defaultSettings: {
					editable: {
						'!type': 'bool',
						'!doc': ''
					}
				},
				NOTIFICATION_TYPE: {
					INFORMATION: 'string',
					WARNING: 'string',
					ERROR: 'string',
					SUCCESS: 'string'
				},
				'prototype': {
					'show': {
						'!type': 'fn() -> !this',
						'!doc': 'public methods'
					},
					'hide': {
						'!type': 'fn() -> !this',
					}
				}
			},

			NumberDisplay: {
				'!proto': 'OutputWidget',
				properties: {
					valueElement: {
						'!doc': ''
					},
					backgroundImage: {
						'!type': 'string',
						'!doc': ''
					},
					subtext: {
						'!type': 'string',
						'!doc': ''
					},
					mask: {
						'!type': 'string',
						'!doc': ''
					},
					defaultValue: {
						'!type': 'string',
						'!doc': ''
					}
				},
				defaultSettings: {
					numberDisplayAlign: {
						'!type': 'string',
						'!doc': ''
					},
					useBackgroundColor: {
						'!type': 'bool',
						'!doc': ''
					}
				},
				'prototype': {
					'setAlignment': {
						'!type': 'fn(align: string) -> !this',
						'!doc': '@param {string} align \'left\', \'right\', \'center\' (default)\n\n@returns {_DP.ComponentTypes.NumberDisplay} this'
					},
					'draw': {
						'!type': 'fn()',
					},
					'applyDimensions': {
						'!type': 'fn()',
					},
					'drawContent': {
						'!type': 'fn() -> !this',
						'!doc': 'clears its container and draws the content\n\n@returns {_DP.ComponentTypes.NumberDisplay} this'
					}
				}
			},

			Page: {
				'!proto': 'DashboardComponent',
				properties: {
					description: {
						'!type': 'string',
						'!doc': ''
					},
					showInMenu: {
						'!type': 'bool',
						'!doc': ''
					},
					enabled: {
						'!type': 'bool',
						'!doc': ''
					},
					pageIndex: {
						'!doc': ''
					},
					active: {
						'!type': 'bool',
						'!doc': ''
					},
					fetching: {
						'!type': 'bool',
						'!doc': ''
					},
					page: {
						'!doc': ''
					},
					visible: {
						'!type': 'bool',
						'!doc': ''
					}
				},
				'prototype': {
					'add': {
						'!type': 'fn(component: ?) -> !this',
						'!doc': 'Adds a container to the page\n\n@returns {_DP.ComponentTypes.Page} self'
					},
					'draw': {
						'!type': 'fn(parentNode: ?) -> !this.DOMElement',
						'!doc': 'Asks all children (containers) to draw themselves and returns the result'
					},
					'setTitle': {
						'!type': 'fn(title: ?) -> !this',
					},
					'getTitle': {
						'!type': 'fn() -> !this.title',
					},
					'hide': {
						'!type': 'fn(transition: ?) -> !this',
					},
					'show': {
						'!type': 'fn(parentNode?: ?, transition?: string) -> !this',
						'!doc': 'Shows the page if it isn\'t visible already. Draws the page if it isn\'t drawn already.\n\n@param {Element} [parentNode] A DOM Element to draw itself in\n@param {string} [transition=_DP.ComponentTypes.Dashboard.PAGE_TRANSITION.NONE] A show transition to use, see _DP.ComponentTypes.Dashboard.PAGE_TRANSITION\n\n@returns {_DP.ComponentTypes.Page} This object'
					},
					'update': {
						'!type': 'fn() -> ?',
						'!doc': 'Updates this page\'s content based on new input settings.\n\n@param {Object} inputSettings (optional) An inputsettings object.\n\n@returns {_DP.ComponentTypes.Page} This object.'
					},
					'copy': {
						'!type': 'fn() -> Page.prototype.copy.!ret',
					},
					'fadeIn': {
						'!type': 'fn()',
					},
					'fadeOut': {
						'!type': 'fn()',
					},
					'disable': {
						'!type': 'fn() -> !this',
					},
					'enable': {
						'!type': 'fn() -> !this',
					},
					'isVisible': {
						'!type': 'fn() -> !this.active',
					},
					'generateId': {
						'!type': 'fn() -> !this',
					}
				}
			},

			PageFooter: {
				'!proto': 'Container'
			},

			PageHeader: {
				'!proto': 'Container',
				properties: {
					isFixed: {
						'!type': 'bool',
						'!doc': ''
					}
				},
				'prototype': {
					'draw': {
						'!type': 'fn(parentNode: ?)',
						'!doc': 'PageHeader.prototype = new Super();\nPageHeader.prototype.constructor = PageHeader;'
					},
					'fix': {
						'!type': 'fn()',
					}
				}
			},

			PeriodBar: {
				'!proto': 'Control',
				properties: {
					min: {
						'!type': 'number',
						'!doc': ''
					},
					max: {
						'!type': 'number',
						'!doc': ''
					},
					tickInterval: {
						'!type': 'number',
						'!doc': ''
					},
					bigTickInterval: {
						'!type': 'number',
						'!doc': ''
					},
					startValue: {
						'!type': 'number',
						'!doc': ''
					},
					endValue: {
						'!type': 'number',
						'!doc': ''
					},
					tickLimit: {
						'!type': 'number',
						'!doc': ''
					}
				}
			},

			PeriodInput: {
				'!proto': 'InputWidget',
				properties: {
					hasPopup: {
						'!type': 'bool',
						'!doc': ''
					},
					hasResetButton: {
						'!type': 'bool',
						'!doc': ''
					},
					startComponent: {
						'!doc': ''
					},
					endComponent: {
						'!doc': ''
					},
					passDataToControls: {
						'!type': 'bool',
						'!doc': ''
					},
					startInputSetting: {
						'!type': 'string',
						'!doc': ''
					},
					endInputSetting: {
						'!type': 'string',
						'!doc': ''
					},
					min: {
						'!type': 'number',
						'!doc': ''
					},
					max: {
						'!type': 'number',
						'!doc': ''
					},
					dateTimeEnabled: {
						'!type': 'bool',
						'!doc': ''
					},
					showMinute: {
						'!type': 'bool',
						'!doc': ''
					},
					maxRange: {
						'!type': 'number',
						'!doc': ''
					},
					minRange: {
						'!type': 'number',
						'!doc': ''
					}
				},
				'prototype': {
					'setStartValue': {
						'!type': 'fn(value: number) -> !this',
						'!doc': 'public methods'
					},
					'setEndValue': {
						'!type': 'fn(value: number) -> !this',
					},
					'draw': {
						'!type': 'fn() -> PeriodBar.prototype.draw.!ret',
					},
					'redraw': {
						'!type': 'fn() -> !this',
						'!doc': '@augments _DP.ComponentTypes.DashboardComponent#redraw\n@returns {_DP.ComponentTypes.PeriodBar} This object'
					},
					'getStartValue': {
						'!type': 'fn() -> !this.startValue',
					},
					'getEndValue': {
						'!type': 'fn() -> !this.endValue',
					},
					'centerOnSelection': {
						'!type': 'fn() -> !this',
						'!doc': 'Centers the visible portion of the PeriodBar on the selected period\n@returns {_DP.ComponentTypes.PeriodBar} This object'
					},
				}
			},

			PeriodSelector: {
				'!proto': 'InputWidget',
				properties: {
					selectorStyle: {
						'!type': 'string',
						'!doc': '',
						'!data': 'PeriodSelector.SELECTOR_STYLE'
					},
					startInputSetting: {
						'!type': 'string',
						'!doc': ''
					},
					endInputSetting: {
						'!type': 'string',
						'!doc': ''
					},
					min: {
						'!type': 'number',
						'!doc': ''
					},
					max: {
						'!type': 'number',
						'!doc': ''
					},
					tickInterval: {
						'!type': 'number',
						'!doc': ''
					},
					bigTickInterval: {
						'!type': 'number',
						'!doc': ''
					},
					inputSettingType: {
						'!type': 'string',
						'!doc': '',
						'!data': 'PeriodSelector.INPUTSETTING_TYPE'
					},
					tickLimit: {
						'!type': 'number',
						'!doc': ''
					}
				},
				defaultSettings: {
					periodSelectorUseUTC: {
						'!type': 'number',
						'!doc': ''
					}
				},
				SELECTOR_STYLE: {
					BAR: 'string',
					FIELDS: 'string'
				},
				INPUTSETTING_TYPE: {
					TIMESTAMP: 'string',
					DAPHNESTRING: 'string',
					DATE: 'string',
					UNIX_TIMESTAMP: 'string'
				}
			},

			Popup: {
				'!proto': 'Container',
				properties: {
					draggable: {
						'!type': 'bool',
						'!doc': ''
					},
					scrollableContent: {
						'!type': 'bool',
						'!doc': ''
					},
					position: {
						'!doc': ''
					},
					visible: {
						'!type': 'bool',
						'!doc': ''
					},
					anchored: {
						'!type': 'bool',
						'!doc': '@deprecated Use popupType property'
					},
					hasCloseButton: {
						'!type': 'bool',
						'!doc': ''
					},
					anchorLocation: {
						'!type': '[]',
						'!doc': '',
						'!data': 'Popup.ANCHOR_LOCATION'
					},
					anchorComponentLocation: {
						'!type': '[]',
						'!doc': '',
						'!data': 'Popup.ANCHOR_LOCATION'
					},
					disablesUI: {
						'!type': 'bool',
						'!doc': '@deprecated Use popupType property'
					},
					enabled: {
						'!type': 'bool',
						'!doc': ''
					},
					showArrow: {
						'!type': 'bool',
						'!doc': '@deprecated'
					},
					arrowPosition: {
						'!type': '[]',
						'!doc': '@deprecated'
					},
					anchorElement: {
						'!doc': ''
					},
					anchorComponent: {
						'!doc': ''
					},
					popupType: {
						'!type': 'string',
						'!doc': '',
						'!data': 'Popup.TYPE'
					}
				},
				defaultSettings: {
					popupCloseButtonImage: {
						'!type': 'string',
						'!doc': ''
					},
					popupTransitionEffect: {
						'!type': 'string',
						'!doc': '',
						'!data': 'Container.TRANSITION_EFFECT'
					},
					popupMinimumBodyHeight: {
						'!type': 'number',
						'!doc': ''
					}
				},
				ANCHOR_LOCATION: {
					TOP_LEFT: '[]',
					TOP_CENTER: '[]',
					TOP_RIGHT: '[]',
					CENTER_RIGHT: '[]',
					BOTTOM_RIGHT: '[]',
					BOTTOM_CENTER: '[]',
					BOTTOM_LEFT: '[]',
					CENTER_LEFT: '[]',
					CENTER: '[]'
				},
				TYPE: {
					MODAL: 'string',
					ANCHORED: 'string',
					SLIDEDOWN: 'string'
				},
				'prototype': {
					'update': {
						'!type': 'fn() -> !this',
					},
					'draw': {
						'!type': 'fn() -> ?',
						'!doc': 'Creates and appends the popup element. Exactly like its parent class Container,\nbut adds drag functionality to its header and the parent node defaults to the dashboard node.\n\n@augments _DP.ComponentTypes.Container#draw\n\n@returns {Element} The popup\'s body element'
					},
					'show': {
						'!type': 'fn(parentNode?: ?, callback?: ?, transitionEffect?: string) -> !this',
						'!doc': 'Shows the popup\n\n@augments _DP.ComponentTypes.Container#show\n\n@param {Element} [parentNode] The DOM element to attach itself to\n@param {function} [callback] A callback function which is called after the popup is fully shown\n@param {string} [transitionEffect=\'fade\'] One of _DP.ComponentTypes.Container.TRANSITION_EFFECT, defaults to the value of the setting \'popupTransitionEffect\'\n\n@returns {_DP.ComponentTypes.Popup} This object'
					},
					'hide': {
						'!type': 'fn(callback: ?, transitionEffect: ?)',
						'!doc': 'Hides the popup\n\n@augments _DP.ComponentTypes.Container#hide\n\n@param {function} [callback] A callback function which is called after the popup is fully hidden\n@param {string} [transitionEffect=\'fade\'] One of _DP.ComponentTypes.Container.TRANSITION_EFFECT, defaults to the value of the setting \'popupTransitionEffect\'\n\n@returns {_DP.ComponentTypes.Popup} This object'
					},
					'centerScreen': {
						'!type': 'fn() -> !this',
						'!doc': 'Sets the popup\'s position to the center of the screen\n\n@returns {_DP.ComponentTypes.Popup} This object'
					},
					'fadeOutUI': {
						'!type': 'fn() -> !this',
						'!doc': 'Creates the disableUILayer that darkens or grays-out the rest of the UI when the popup is shown\n\n@returns {_DP.ComponentTypes.Popup} This object'
					},
					'fadeInUI': {
						'!type': 'fn() -> !this',
						'!doc': 'Removes the disableUILayer when the popup gets hidden\n\n@returns {_DP.ComponentTypes.Popup} This object'
					},
					'setScrollableContent': {
						'!type': 'fn(scrollable: ?) -> !this',
					},
					'getScrollableContent': {
						'!type': 'fn() -> !this.scrollableContent',
						'!doc': 'Returns a boolean value indicating whether the popup\'s content is scrollable. The default for modal popups is true, for other popus is false.\n\n@returns {boolean}'
					},
					'setPosition': {
						'!type': 'fn(left: ?, top: ?)',
					},
					'anchor': {
						'!type': 'fn(component: ?, anchorLocation: [?], anchorToLocation: [?]) -> !this',
						'!doc': 'Anchors the popup to another component.\nThis will cause the popup to be positioned relative to this other component when shown.\n\n@param {DashboardComponent} component The component to anchor to\n@param {Array} anchorLocation The point of the Popup that is anchored to the component. One of the _DP.ComponentTypes.Popup.ANCHOR_LOCATION constants.\n@param {Array} anchorToLocation The point of the component that the Popup is anchored to. One of the _DP.ComponentTypes.Popup.ANCHOR_LOCATION constants.\n\n@returns {_DP.ComponentTypes.Popup} This object'
					},
					'drawArrow': {
						'!type': 'fn() -> !this',
					},
					'drawContent': {
						'!type': 'fn() -> !this',
						'!doc': '@augments _DP.ComponentTypes.Container#drawContent\n\n@returns {_DP.ComponentTypes.Popup} This object'
					},
					'drawContentDone': {
						'!type': 'fn()',
					},
					'applyDimensions': {
						'!type': 'fn() -> !this',
					},
					'undraw': {
						'!type': 'fn() -> ?',
						'!doc': 'Removes resize event handler, calls the parent\'s undraw method.\n\n@augments _DP.ComponentTypes.Container#undraw\n\n@returns {_DP.ComponentTypes.Popup} This object'
					},
					'getPopupType': {
						'!type': 'fn() -> !this.popupType',
						'!doc': 'Returns the popupType of this popup (modal, anchored or slidedown).\n\n@returns {string} The popupType'
					},
					'setPopupType': {
						'!type': 'fn(popupType: string) -> !this',
						'!doc': 'Sets the popupType for this popup.\n@see _DP.ComponentTypes.Popup.TYPE\n\n@param {string} popupType The popupType\n\n@returns {_DP.ComponentTypes.Popup} This object'
					},
					'scrollIntoView': {
						'!type': 'fn() -> !this',
						'!doc': 'Scrolls the popup into view if it is (partly) obscured.\n\n@returns {_DP.ComponentTypes.Popup} This object'
					}
				}
			},

			SearchBox: {
				'!proto': 'InputWidget',
				properties: {
					hasResetButton: {
						'!type': 'bool',
						'!doc': ''
					},
					hasSettingsButton: {
						'!type': 'bool',
						'!doc': ''
					},
					inputSettings: {
						'!doc': ''
					},
					hasHeader: {
						'!type': 'bool',
						'!doc': ''
					},
					textInput: {
						'!type': 'TextInput',
						'!doc': ''
					},
					label: {
						'!type': 'string',
						'!doc': ''
					},
					onSearch: {
						'!type': 'bool',
						'!doc': '@deprecated'
					},
					hasPopup: {
						'!type': 'bool',
						'!doc': ''
					},
					image: {
						'!type': 'string',
						'!doc': ''
					},
					button: {
						'!type': 'Button',
						'!doc': ''
					}
				},
				'prototype': {
					'draw': {
						'!type': 'fn()',
						'!doc': 'SearchBox.prototype = new Super();\nSearchBox.prototype.constructor = SearchBox;'
					},
					'drawContent': {
						'!type': 'fn()',
					},
					'setLabel': {
						'!type': 'fn(label: ?) -> !this',
					},
					'getLabel': {
						'!type': 'fn() -> !this.label',
					},
					'setImage': {
						'!type': 'fn(imageName: ?) -> !this',
					},
					'getImage': {
						'!type': 'fn() -> !this.image',
					},
					'setValue': {
						'!type': 'fn(value: ?) -> !this',
					},
					'getValue': {
						'!type': 'fn() -> !this.textInput',
					}
				}
			},

			Selectbox: {
				'!proto': 'Control',
				properties: {
					value: {
						'!type': 'string',
						'!doc': ''
					},
					listElement: {
						'!doc': ''
					},
					options: {
						'!type': '[]',
						'!doc': ''
					},
					title: {
						'!type': 'string',
						'!doc': ''
					}
				},
				'prototype': {
					'setData': {
						'!type': 'fn(data: ?) -> !this',
						'!doc': 'Sets the data for this select box\n\nExamples\n(start code)\n{label:\'Vrouw\', value:\'vrouw\'} -- just an option\n\n[{label: \'-- select gender --\', value: 0, disabled: true}, {label: \'Vrouw\', value: \'vrouw\'}, {label: \'Man\', value: \'man\'}]\n\n{label:\'Geslacht\', value:[{label:\'Vrouw\', value:\'vrouw\'}, {label:\'Man\', value:\'man\'}]} -- option group with options\n(end)\n\n@param {object} data data object (see Examples)\n\n@returns {} this'
					},
					'draw': {
						'!type': 'fn() -> !this.DOMElement',
						'!doc': 'Draws the Selectbox in its parent node and adds any appropriate event handlers\n\n@param {HTMLElement} parentNode The node to draw itself in\n\n@returns {HTMLElement} This object\'s outer DOM element'
					},
					'getSelectedOption': {
						'!type': 'fn() -> !this.options.<i>',
					},
					'setListHeight': {
						'!type': 'fn(listHeight: ?)',
					},
					'getListHeight': {
						'!type': 'fn()',
					},
					'getValue': {
						'!type': 'fn() -> !this.value',
					},
					'setValue': {
						'!type': 'fn(value: ?) -> !this',
					}
				}
			},

			SelectButtons: {
				'!proto': 'InputWidget',
				properties: {
					options: {
						'!type': '[]',
						'!doc': ''
					},
					buttons: {
						'!doc': ''
					},
					selectedButton: {
						'!doc': ''
					},
					hasResetButton: {
						'!type': 'bool',
						'!doc': ''
					},
					hasSettingsButton: {
						'!type': 'bool',
						'!doc': ''
					},
					hasButtonSeparator: {
						'!type': 'bool',
						'!doc': ''
					},
					hasHeader: {
						'!type': 'bool',
						'!doc': ''
					},
					buttonStyle: {
						'!type': 'string',
						'!doc': '',
						'!data': 'Button.BUTTON_STYLE'
					},
					buttonSize: {
						'!type': 'string',
						'!doc': '',
						'!data': 'Button.SIZE'
					},
					imageName: {
						'!type': 'string',
						'!doc': ''
					},
					updateFromInputSettings: {
						'!type': 'bool',
						'!doc': ''
					},
					alignment: {
						'!type': 'string',
						'!doc': '',
						'!data': 'SelectButtons.ALIGNMENT'
					},
					allowDeselect: {
						'!type': 'bool',
						'!doc': ''
					}
				},
				ALIGNMENT: {
					CENTER: 'string',
					LEFT: 'string',
					RIGHT: 'string'
				},
				'prototype': {
					'drawContent': {
						'!type': 'fn()',
					},
					'select': {
						'!type': 'fn(button: ?) -> !this',
						'!doc': 'Toggles selection of the given button\n\n@param {_DP.ComponentTypes.Button} button The button\n\n@returns {_DP.ComponentTypes.SelectButtons} This object'
					},
					'getButtonStyle': {
						'!type': 'fn() -> !this.buttonStyle',
					},
					'getButtonSize': {
						'!type': 'fn() -> !this.buttonSize',
					},
					'applyInputSettings': {
						'!type': 'fn()',
					},
					'setValue': {
						'!type': 'fn(value: ?) -> !this',
					},
					'getValue': {
						'!type': 'fn() -> !this.selectedButton',
					},
					'getButtonByValue': {
						'!type': 'fn(value: ?) -> !this.buttons.<i>',
					},
					'selectOption': {
						'!type': 'fn(value: ?) -> !this',
					},
					'getImage': {
						'!type': 'fn() -> !this.imageName',
					},
					'showSelectedInputSettings': {
						'!type': 'fn() -> !this',
					},
					'getSelectedButton': {
						'!type': 'fn() -> !this.selectedButton',
					},
					'getSelectedOption': {
						'!type': 'fn()',
					},
					'selectNone': {
						'!type': 'fn() -> !this',
					}
				}
			},

			Selector: {
				'!proto': 'InputWidget',
				properties: {
					hasResetButton: {
						'!type': 'bool',
						'!doc': ''
					},
					hasSettingsButton: {
						'!type': 'bool',
						'!doc': ''
					},
					listElement: {
						'!doc': ''
					},
					inputSettings: {
						'!doc': ''
					},
					listControl: {
						'!type': 'NestedList',
						'!doc': ''
					},
					inputControls: {
						'!type': '[]',
						'!doc': ''
					},
					selected: {
						'!doc': ''
					},
					hasPopup: {
						'!type': 'bool',
						'!doc': ''
					}
				},
				'prototype': {
					'draw': {
						'!type': 'fn() -> !this.bodyDOMElement',
						'!doc': 'Draws the inputwidget. First sets the nested list\'s title to its own title,\nthen calls parent\'s draw to handle the rest of the drawing\n\n@param {HTMLElement} parentnode The node to draw itself in\n\n@returns {HTMLElement} Its own body node'
					},
					'drawContent': {
						'!type': 'fn()',
						'!doc': 'Updates the InputWidget to display its selected input settings\n\n@returns {} void'
					},
					'drawList': {
						'!type': 'fn(data: [?]) -> ?',
						'!doc': 'Draws the list of selected options. Recursively draws nested levels.\n\n@param {Array} data The data array used to define the Selector\'s options\n\n@returns {HTMLUListElement} A reference to the created list node'
					},
					'countShownChildren': {
						'!type': 'fn(dataRow: ?) -> number',
						'!doc': 'Recursive method that counts the number of children that should be shown\nbased on whether they are selected and whether their children should be shown\n\n@param {Object} dataRow data object from the data array corresponding to one option\n\n@returns {integer} Number of children of the specified item that should be shown'
					},
					'prepareSettings': {
						'!type': 'fn() -> !this',
						'!doc': 'Sets the selected propery according to the inputsettings object.\nIt converts the values from a list of selected values, to an associative\narray, with the format:\nthis.selected: {\ninputsetting1: {value1: true, value2: true, ...},\ninputsetting2: {value1: true, value2: true, ...},\n...\n}\nThis way it can be easily used for displaying without having to search the\ninputSettingsarray repeatedly.\n\n@returns {_DP.ComponentTypes.Selector} This object'
					}
				}
			},

			Slider: {
				'!proto': 'Control',
				properties: {
					min: {
						'!type': 'number',
						'!doc': ''
					},
					max: {
						'!type': 'number',
						'!doc': ''
					},
					step: {
						'!type': 'number',
						'!doc': ''
					}
				}
			},

			Stockchart: {
				'!proto': 'Highchart',
				'prototype': {
					'createChart': {
						'!type': 'fn() -> !this',
						'!doc': 'Creates the stockchart instance and sets instance\'s child to this one\n\n@returns {_DP.ComponentTypes.Stockchart} This object'
					},
					'toJSON': {
						'!type': 'fn() -> Stockchart.prototype.toJSON.!ret',
					}
				}
			},

			Table: {
				'!proto': 'OutputWidget',
				properties: {
					lastSortedColumnName: {
						'!type': 'string',
						'!doc': ''
					},
					showHeader: {
						'!type': 'bool',
						'!doc': ''
					},
					sortColumnIndex: {
						'!type': 'number',
						'!doc': ''
					},
					lastSortedColumnIndex: {
						'!type': 'number',
						'!doc': ''
					},
					sortDirection: {
						'!type': 'string',
						'!doc': ''
					},
					columnDefinitions: {
						'!type': '[]',
						'!doc': ''
					},
					rowCount: {
						'!type': 'number',
						'!doc': ''
					},
					data: {
						'!type': '[]',
						'!doc': ''
					},
					sortable: {
						'!type': 'bool',
						'!doc': ''
					},
					maxColumnValues: {
						'!type': '[]',
						'!doc': ''
					},
					firstData: {
						'!type': '[]',
						'!doc': ''
					},
					pageSize: {
						'!type': 'number',
						'!doc': ''
					},
					pageNr: {
						'!type': 'number',
						'!doc': ''
					},
					pageData: {
						'!type': '[]',
						'!doc': ''
					},
					alwaysShowFixedRows: {
						'!type': 'bool',
						'!doc': ''
					},
					fixedColumnWidths: {
						'!type': 'bool',
						'!doc': ''
					},
					rowBorders: {
						'!type': 'bool',
						'!doc': ''
					},
					useServerSidePaging: {
						'!type': 'bool',
						'!doc': ''
					},
					useServerSideSorting: {
						'!type': 'bool',
						'!doc': ''
					},
					columnGroups: {
						'!type': '[]',
						'!doc': ''
					},
					filter: {
						'!doc': ''
					},
					exportDefinitions: {
						'!type': '[]',
						'!doc': ''
					},
					sortNeeded: {
						'!type': 'bool',
						'!doc': ''
					},
					inputSetting: {
						'!type': 'string',
						'!doc': ''
					},
					totalRowCount: {
						'!type': 'number',
						'!doc': ''
					},
					rowClickHandler: {
						'!doc': ''
					},
					updateDetailComponentOnExpand: {
						'!type': 'bool',
						'!doc': ''
					},
					stickyColumns: {
						'!type': 'bool',
						'!doc': ''
					},
					stickyHeader: {
						'!type': 'bool',
						'!doc': ''
					},
					persistExpandedRow: {
						'!type': 'bool',
						'!doc': ''
					},
					detailComponent: {
						'!doc': ''
					},
					tableHeaderElement: {
						'!doc': ''
					},
					tableElement: {
						'!doc': ''
					},
					tbody: {
						'!doc': ''
					},
					pagerElement: {
						'!doc': ''
					},
					firstElement: {
						'!doc': ''
					},
					previousElement: {
						'!doc': ''
					},
					nextElement: {
						'!doc': ''
					},
					lastElement: {
						'!doc': ''
					},
					indentRows: {
						'!type': 'number',
						'!doc': ''
					},
					detailRow: {
						'!doc': ''
					},
					expandedRowValue: {
						'!doc': ''
					},
					filteredData: {
						'!doc': ''
					},
					visibleColumnCount: {
						'!type': 'number',
						'!doc': ''
					},
					clickedRowIndex: {
						'!doc': ''
					}
				},
				defaultSettings: {
					outputWidgetExportOptions: {
						'!type': '[]',
						'!doc': "{value: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', label: 'Excel', inputType: 'JSON'}"
					},
					tablePagerShowPageNumbers: {
						'!type': 'bool',
						'!doc': ''
					},
					tablePagerRange: {
						'!type': 'number',
						'!doc': ''
					},
					tableHighlightColumns: {
						'!type': 'bool',
						'!doc': ''
					},
					tableShowBars: {
						'!type': 'bool',
						'!doc': ''
					},
					tableNoDataMessage: {
						'!type': 'string',
						'!doc': ''
					},
					tablePreviousPageLabel: {
						'!type': 'string',
						'!doc': ''
					},
					tableNextPageLabel: {
						'!type': 'string',
						'!doc': ''
					},
					stayOnPageOnUpdate: {
						'!type': 'bool',
						'!doc': ''
					}
				},
				'prototype': {
					'EVENT_CATEGORY': {
						'!type': 'string',
						'!doc': 'Table.prototype = new Super();\nTable.prototype.constructor = Table;'
					},
					'COLUMN_TYPE': {
						'STRING': {
							'!type': 'string',
						},
						'NUMBER': {
							'!type': 'string',
						},
						'PERCENTAGE': {
							'!type': 'string',
						},
					},
					'setData': {
						'!type': 'fn(data: [?]) -> !this',
						'!doc': 'Sets an object containing data for the table to display\n\n@param {Array} data An object containing data for this widget\n\n@returns {_DP.ComponentTypes.Table} This object'
					},
					'setAlwaysShowFixedRows': {
						'!type': 'fn(bool: bool)',
					},
					'setShowBars': {
						'!type': 'fn(show: bool) -> !this',
						'!doc': 'If set, it will show progress bars according the value of each cell\n\n@param {boolean} show If set to TRUE, it will show bars\n\n@returns {} this'
					},
					'setShowHighlight': {
						'!type': 'fn(show: bool) -> !this',
						'!doc': 'If set, it will produce a hover effect\n\n@param {boolean} show If set to TRUE, it will show a hover effect\n\n@returns {} this'
					},
					'setColumnDefinitions': {
						'!type': 'fn(definitions: ?) -> !this',
						'!doc': 'Sets the column defintions\n\n@param {array} defintions defintions\n\n@returns {} this'
					},
					'setSortColumn': {
						'!type': 'fn(columnIndex: ?, sortOrder: string) -> !this',
						'!doc': 'Sets the column where to sort on on load, with its sort order.\nDefault sortorder is \'asc\'.\n\n@param {string} columnName the index of the column to sort on\n@param {string} sortOrder \'asc\' or \'desc\' -- default s \'asc\'\n\n@returns {} DataTable - this'
					},
					'draw': {
						'!type': 'fn() -> !this.bodyDOMElement',
						'!doc': 'Draws the table widget\n\n@augments _DP.ComponentTypes.OutputWidget#draw\n\n@returns {HTMLDivElement} The body element of the widget'
					},
					'fetchData': {
						'!type': 'fn()',
					},
					'updateCell': {
						'!type': 'fn(rowValue: ?, columnIndex: ?, newData: ?)',
					},
					'highlightColumn': {
						'!type': 'fn(cellElement: Table.prototype._createCellContent.!ret) -> bool',
						'!doc': 'Shows a hover effect\n\n@param {HTMLElement} cell the cell which is hovered\n\n@returns {} void'
					},
					'unhighlightColumn': {
						'!type': 'fn(cellElement: Table.prototype._createCellContent.!ret) -> bool',
						'!doc': 'Removes the hover effect (after it is set)\n\n@param {HTMLElement} cell the cell which is hovered\n\n@returns {} void'
					},
					'setPageSize': {
						'!type': 'fn(pageSize: number) -> !this',
						'!doc': 'Creates Sets the number of records to show in the table\n\n@param {number} pageSize defaults to 0, maximum of 50 records\n\n@returns {} this'
					},
					'getPagesRange': {
						'!type': 'fn() -> [number]',
						'!doc': 'We have 3 sets of pages, one showing the first page (and eventually pages according to setsize)\none showing the current page and pages according to setsize\none showing the last page and pages according to setsize\nOne of these arrays could also be empty. Example:\n[0..3][][] If we only have 4 pages and the current is 2 and total number of pages = 4\n\n@returns {} range <array> 3 sets with page numbers (or empty ones, also possible)'
					},
					'toJSON': {
						'!type': 'fn() -> ?',
						'!doc': 'Returns the contents of the Table in JSON format.\nUsed for sending the formatted data to the backend for exporting and downloading.\n\n@returns {object} A JSON object representing the formatted contents of the Table.'
					},
					'addRow': {
						'!type': 'fn(rowData: ?) -> !this',
					},
					'insertRows': {
						'!type': 'fn(data: ?, before: ?) -> !this',
					},
					'insertRow': {
						'!type': 'fn(rowData: ?, before: ?) -> !this',
					},
					'createRow': {
						'!type': 'fn(data: ?) -> Table.prototype.createRow.!ret',
					},
					'update': {
						'!type': 'fn(inputSettings: ?, preservePageNr: bool)',
					},
					'showDetail': {
						'!type': 'fn(rowValue: [?]) -> !this',
						'!doc': 'Expands the detail row of a certain table row and shows the table\'s detail component\n\n@param {*} rowValue The value of the row to expand\n\n@returns {_DP.ComponentTypes.Table}'
					},
					'hideDetail': {
						'!type': 'fn(callback: fn())',
						'!doc': 'Collapses the currently expanded detail row and hides the table\'s detail component\n\n@param {function} [callback] Function to execute after the detail component has hidden\n\n@returns {_DP.ComponentTypes.Table}'
					},
					'getRowByValue': {
						'!type': 'fn(value: [?])',
					},
					'getDataRowByValue': {
						'!type': 'fn(value: ?)',
					},
					'createDetailRow': {
						'!type': 'fn() -> !this',
					},
					'setDetailComponent': {
						'!type': 'fn(component: ?) -> !this',
						'!doc': 'Sets the detail component of this table\n\n@param {_DP.ComponentTypes.DashboardComponent} component The component to be set as the table\'s detail component\n\n@returns {_DP.ComponentTypes.Table} This object'
					},
					'getDetailComponent': {
						'!type': 'fn() -> Table.prototype.getDetailComponent.!ret',
						'!doc': 'Returns the table\'s detail component\n\n@returns {Object} The detail component'
					},
					'navigate': {
						'!type': 'fn(nav: string|number) -> !this',
						'!doc': 'Navigates a table with paging to another page\n\n@param {string|number} nav Either one of the keywords first, previous, next, last, or the number of a page\n\n@returns {_DP.ComponentTypes.Table} This object'
					},
					'createEmptyRows': {
						'!type': 'fn()',
					},
					'applyFilter': {
						'!type': 'fn(filter: ?) -> !this',
					},
					'clearFilter': {
						'!type': 'fn() -> !this',
					},
					'setInputSetting': {
						'!type': 'fn(inputSetting: ?)',
					},
					'getValue': {
						'!type': 'fn() -> !this.value',
					},
					'setValue': {
						'!type': 'fn(value: ?) -> !this',
					},
					'getData': {
						'!type': 'fn() -> [?]',
					},
					'setTotalRowCount': {
						'!type': 'fn(rowCount: ?) -> !this',
					},
					'getPageCount': {
						'!type': 'fn() -> !this.pageCount',
					},
					'drawHeader': {
						'!type': 'fn() -> !this',
					},
					'showFetching': {
						'!type': 'fn() -> ?',
						'!doc': '@augments _DP.ComponentTypes.Widget\n\nCalls showFetching on its prototype and returns its return value, indicating whether to use a slowed loading indicator (or not, the default)\n\n@returns {object} This widget, returned by the prototype function'
					},
					'showFetchingRow': {
						'!type': 'fn(after: ?) -> !this',
					},
					'applyDimensions': {
						'!type': 'fn()',
					},
					'add': {
						'!type': 'fn(component: ?) -> ?',
						'!doc': 'In addition to adding a child component (@see _DP.ComponentTypes.Widget#add), if the added component is a Block,\nit will also be set as the Table\'s detail component.\n\n@augments _DP.ComponentTypes.Widget#add\n\n@param {_DP.ComponentTypes.DashboardComponent} component The component to add\n\n@returns {_DP.ComponentTypes.Table} This object'
					},
					'selectRow': {
						'!type': 'fn(value: ?, selected: bool) -> !this',
					},
					'undraw': {
						'!type': 'fn() -> ?',
						'!doc': 'Undraws the Table (removes all DOM Elements)\nAlso sets the visible property of the detail component to false so it shows properly next time it is expanded\n\n@augments _DP.ComponentTypes.DashboardComponent.undraw\n\n@returns {_DP.ComponentTypes.DashboardComponent} This object'
					},
				}
			},

			TabSelector: {
				'!proto': 'InputWidget',
				properties: {
					hasHeader: {
						'!type': 'bool',
						'!doc': ''
					},
					hasResetButton: {
						'!type': 'bool',
						'!doc': ''
					},
					hasSettingsButton: {
						'!type': 'bool',
						'!doc': ''
					},
					scrollLeftButtonContent: {
						'!type': 'string',
						'!doc': 'Content of the scroll-left button DOM element.'
					},
					scrollRightButtonContent: {
						'!type': 'string',
						'!doc': 'Content of the scroll-right button DOM element.'
					},
					showBottomBorder: {
						'!type': 'bool',
						'!doc': 'Whether to show the bottom border (style-only) class.'
					},
					updateFromInputSettings: {
						'!type': 'bool',
						'!doc': 'Whether to automatically update the selected value from the input-setting.'
					}
				},
				'prototype': {
					'draw': {
						'!type': 'fn() -> ?',
						'!doc': 'Draw the container.\n\n@returns {HTMLDivElement} The component\'s outer DOM element.'
					},
					'drawContent': {
						'!type': 'fn()',
						'!doc': 'Draw the widget content.'
					},
					'selectTab': {
						'!type': 'fn(tabValue: ?) -> !this',
						'!doc': 'Select a tab by value\n\n@param {*} tabValue Value of the tab to select.\n\n@returns {_DP.ComponentTypes.TabSelector} This object'
					},
					'scroll': {
						'!type': 'fn(index: number, relative: bool)',
						'!doc': 'Scroll the tab list.\n\n@param {number} index How many tabs to scroll to the right (positive) or left (negative).\n@param {boolean} relative (optional) Whether the index parameter is absolute (false, default) or relative to the current scroll state (true);'
					},
					'applyInputSettings': {
						'!type': 'fn()',
						'!doc': 'Apply the input-settings on linked components.'
					},
					'setValue': {
						'!type': 'fn(value: ?) -> !this',
						'!doc': 'Set the (selected) value.\n\n@param {*} value Value to select.'
					},
					'getValue': {
						'!type': 'fn() -> !this._selectedValue',
						'!doc': 'Get the (selected) value.\n\n@returns {*} The currently selected value'
					}
				}
			},

			TextElement: {
				'!proto': 'OutputWidget',
				properties: {
					text: {
						'!type': 'string',
						'!doc': ''
					},
					textAlignment: {
						'!type': 'string',
						'!doc': ''
					},
					value: {
						'!doc': ''
					},
					inputSetting: {
						'!type': 'string',
						'!doc': ''
					},
					textElement: {
						'!doc': ''
					},
					stripHTML: {
						'!type': 'bool',
						'!doc': 'If true, all HTML tags will be removed'
					},
					escapeHTML: {
						'!type': 'bool',
						'!doc': 'If true, all HTML tags will be escaped'
					}
				},
				'prototype': {
					'draw': {
						'!type': 'fn()',
						'!doc': 'TextElement.prototype = new Super();\nTextElement.prototype.constructor = TextElement;'
					},
					'drawContent': {
						'!type': 'fn() -> !this',
					},
					'setText': {
						'!type': 'fn(text: string|number, escapeHTML?: bool) -> !this',
						'!doc': 'Sets the text content of the TextElement\n\n@param {string|number} text The text\n@param {boolean} [escapeHTML=false] Whether to replace html text with encoded characters so it will not be parsed as HTML\n\n@returns {_DP.ComponentTypes.TextElement} This object'
					},
					'getValue': {
						'!type': 'fn() -> !this.value',
					},
					'setValue': {
						'!type': 'fn(value: ?) -> !this',
					},
					'setInputSetting': {
						'!type': 'fn(inputSetting: ?)',
					},
					'toJSON': {
						'!type': 'fn() -> TextElement.prototype.toJSON.!ret',
					},
					'getText': {
						'!type': 'fn() -> !this.text',
						'!doc': 'Returns the text (content) of the TextElement\n\n@returns {string} The text content'
					}
				}
			},

			TextInput: {
				'!proto': 'Control',
				properties: {
					labelElement: {
						'!doc': ''
					},
					inputElement: {
						'!doc': ''
					},
					label: {
						'!type': 'string',
						'!doc': ''
					},
					value: {
						'!type': 'string',
						'!doc': ''
					},
					maxLength: {
						'!type': 'number',
						'!doc': ''
					},
					onKeyPress: {
						'!doc': ''
					},
					multiLine: {
						'!type': 'bool',
						'!doc': ''
					},
					lines: {
						'!type': 'number',
						'!doc': ''
					},
					infoText: {
						'!type': 'string',
						'!doc': ''
					},
					masked: {
						'!type': 'bool',
						'!doc': ''
					},
					inputType: {
						'!type': 'string',
						'!doc': ''
					}
				},
				INPUT_TYPE: {
					TEXT: 'string',
					PASSWORD: 'string',
					NUMBER: 'string',
					DATE: 'string'
				},
				'prototype': {
					'draw': {
						'!type': 'fn() -> !this.DOMElement',
						'!doc': 'Draws the TextInput in its parent node and adds the appropriate event handlers\n\n@param {HTMLElement} parentNode The node to draw itself in\n\n@returns {HTMLElement} This object\'s outer DOM element'
					},
					'setValue': {
						'!type': 'fn(value: string|number) -> !this',
						'!doc': 'Sets the value of the text input\n\n@param {string|number} value\n\n@returns {_DP.ComponentTypes.TextInput} This object'
					},
					'getValue': {
						'!type': 'fn() -> !this.value',
						'!doc': 'Returns the value of the TextInput\n\n@returns {string|number} The value, number if inputType is NUMBER, string otherwise'
					},
					'setMaxLength': {
						'!type': 'fn(maxLength: ?) -> !this',
					},
					'getMaxLength': {
						'!type': 'fn() -> !this.maxLength',
					},
					'setOnKeyPress': {
						'!type': 'fn(keyCode: number, handler: ?) -> !this',
					},
					'handleKeyPress': {
						'!type': 'fn(keyCode: ?, e: ?) -> !this',
					},
					'applyDimensions': {
						'!type': 'fn() -> !this',
						'!doc': '@param {DOMElement} elem The element to apply the dimensions to.\n@returns {TextInput}'
					},
					'setInfoText': {
						'!type': 'fn(infoText: ?) -> !this',
					},
					'clearInfoText': {
						'!type': 'fn() -> !this',
						'!doc': 'Clears the info text (placeholder text)\n\n@returns {_DP.ComponentTypes.TextInput}'
					},
					'clear': {
						'!type': 'fn() -> !this',
						'!doc': 'Clears the TextInput\n\n@returns {_DP.ComponentTypes.TextInput} This object'
					},
					'setMasked': {
						'!type': 'fn(bool: ?) -> !this',
					},
					'setFocus': {
						'!type': 'fn() -> !this',
					},
					'setMultiLine': {
						'!type': 'fn(bool: ?) -> !this',
					},
					'setLines': {
						'!type': 'fn(lines: ?) -> !this',
					},
					'getLines': {
						'!type': 'fn() -> !this.lines',
					},
					'setInputType': {
						'!type': 'fn(inputType: ?) -> !this',
					},
					'onShow': {
						'!type': 'fn() -> !this',
						'!doc': '@augments _DP.ComponentTypes.DashboardComponent#onShow\n\nInitializes the placeholder polyfill and the rich text component\n\n@returns {_DP.ComponentTypes.TextInput} This object'
					},
					'onHide': {
						'!type': 'fn() -> ?',
						'!doc': '@augments _DP.ComponentTypes.DashboardComponent#onHide\n\nDestroys the rich text component\n\n@returns {_DP.ComponentTypes.TextInput} This object'
					},
					'setRichText': {
						'!type': 'fn(richText: bool) -> !this',
						'!doc': 'Sets whether the TextInput should behave as a rich text input\n\n@param {boolean} richText True enabled rich text, false disables it\n\n@returns {_DP.ComponentTypes.TextInput} This object'
					},
					'undraw': {
						'!type': 'fn() -> ?',
						'!doc': 'Destroys the rich text editor if it exists\n\n@augments {_DP.ComponentTypes.DashboardComponent#undraw}\n\n@returns {_DP.ComponentTypes.TextInput} This object'
					},
					'attachEventHandler': {
						'!type': 'fn(controlNode: ?, event: ?, handler: ?) -> !this',
						'!doc': 'Attaches the defined event handler to the given controlNode, or registers the event handler for deferred attaching to richtext control\n\n@augments {_DP.ComponentTypes.DashboardComponent#attachEventHandler}\n\n@returns {_DP.ComponentTypes.TextInput} This object'
					}
				}
			},

			TextInputWidget: {
				'!proto': 'InputWidget',
				properties: {
					infoText: {
						'!type': 'string',
						'!doc': ''
					},
					hasClearButton: {
						'!type': 'bool',
						'!doc': ''
					},
					clearButtonDrawn: {
						'!type': 'bool',
						'!doc': ''
					},
					masked: {
						'!type': 'bool',
						'!doc': ''
					},
					multiLine: {
						'!type': 'bool',
						'!doc': ''
					},
					lines: {
						'!type': 'number',
						'!doc': ''
					},
					inputType: {
						'!type': 'string',
						'!doc': ''
					},
					maxLength: {
						'!type': 'number',
						'!doc': ''
					},
					validators: {
						'!type': '[]',
						'!doc': ''
					},
					validationEvent: {
						'!type': 'string',
						'!doc': ''
					},
					clearButton: {
						'!doc': ''
					},
					textInput: {
						'!doc': ''
					},
					hasResetButton: {
						'!type': 'bool',
						'!doc': ''
					},
					hasSettingsButton: {
						'!type': 'bool',
						'!doc': ''
					},
					hasPopup: {
						'!type': 'bool',
						'!doc': ''
					}
				},
				'prototype': {
					'draw': {
						'!type': 'fn()',
					},
					'drawContent': {
						'!type': 'fn()',
					},
					'setInfoText': {
						'!type': 'fn(text: ?) -> !this',
					},
					'setValue': {
						'!type': 'fn(value: ?) -> !this',
					},
					'stopDrag': {
						'!type': 'fn() -> bool',
						'!doc': 'Reinitializes the inner rich text component after dragging is done\n\n@augments _DP.ComponentTypes.DashboardComponent#stopDrag\n\n@protected\n\n@returns {bool} the return value of the Super\'s stopDrag method'
					},
					'attachEventHandler': {
						'!type': 'fn(controlNode: ?, event: ?, handler: ?) -> !this',
						'!doc': 'Attaches the defined event handler to the given controlNode. Delegates the procedure to the inner control if it\'s a richtext input\n\n@augments {_DP.ComponentTypes.DashboardComponent#attachEventHandler}\n\n@returns {_DP.ComponentTypes.TextInputWidget} This object'
					}
				}
			},

			TimeDisplay: {
				'!proto': 'OutputWidget',
				defaultSettings: {
					useBackgroundColor: {
						'!type': 'bool',
						'!doc': ''
					}
				},
				'prototype': {
					'processTimeValues': {
						'!type': 'fn(seconds: number) -> TimeDisplay.prototype.processTimeValues.!ret',
						'!doc': 'TimeDisplay.prototype = new Super();\nTimeDisplay.prototype.constructor = TimeDisplay;'
					},
					'displayTimeValue': {
						'!type': 'fn(value: number, highlight: bool, postFix: string) -> TimeDisplay.prototype.displayTimeValue.!ret',
					},
					'drawContent': {
						'!type': 'fn()',
					}
				}
			},

			TokenInput: {
				'!proto': 'InputWidget',
				properties: {
					maxOptions: {
						'!type': 'number',
						'!doc': ''
					},
					infoText: {
						'!type': 'string',
						'!doc': ''
					},
					maxSelections: {
						'!type': 'number',
						'!doc': ''
					},
					allowAddCustomTokens: {
						'!type': 'bool',
						'!doc': ''
					},
					hasResetButton: {
						'!type': 'bool',
						'!doc': ''
					},
					hasSettingsButton: {
						'!type': 'bool',
						'!doc': ''
					},
					hasPopup: {
						'!type': 'bool',
						'!doc': ''
					},
					values: {
						'!type': '[]',
						'!doc': 'The initial selected values'
					}
				},
				'prototype': {
					'draw': {
						'!type': 'fn() -> ?',
						'!doc': 'Draws the component.\n\n@augments _DP.ComponentTypes.InputWidget#draw\n\n@returns {HTMLElement} This component\'s body DOM element'
					},
					'setInfoText': {
						'!type': 'fn(text: string) -> !this',
						'!doc': 'Sets the info text of the textinput.\n\n@param {string} text\n\n@returns {_DP.ComponentTypes.TokenInput} This object'
					},
					'drawContent': {
						'!type': 'fn() -> ?',
						'!doc': 'Draws the content of the component.\n\n@augments _DP.ComponentTypes.Widget#drawContent\n\n@returns {_DP.ComponentTypes.Widget} This object'
					},
					'clearSelection': {
						'!type': 'fn() -> !this',
						'!doc': 'Clears the selection by deselecting all items and removing the labels.\n\n@returns {_DP.ComponentTypes.TokenInput} This object'
					},
					'clear': {
						'!type': 'fn() -> !this',
					},
					'getValue': {
						'!type': 'fn() -> [?]|string',
						'!doc': 'Returns the selected values, or the content of the text field if nothing is selected.\n\n@returns {Array|string}'
					},
					'setValue': {
						'!type': 'fn(value: [?]|string) -> !this',
						'!doc': 'Sets the selected values, or the content of the text field if a string is passed.\n\n@param {Array|string} value\n\n@returns {_DP.ComponentTypes.TokenInput} This object'
					},
					'deselectItem': {
						'!type': 'fn(item?: ?) -> ?',
						'!doc': 'Deselects a selected item\n\n@param {object} [item] The item from the data set that should be deselected. Defaults to the last selected item.\n\n@returns {_DP.ComponentTypes.TokenInput} This object'
					},
					'getSelectedItems': {
						'!type': 'fn() -> [?]',
						'!doc': 'Returns the selected items.\n\n@returns {Array} An array containing the selected data items'
					},
					'clearTextInput': {
						'!type': 'fn() -> !this',
						'!doc': 'Clears the text input.\n\n@returns {_DP.ComponentTypes.TokenInput} This object'
					},
				}
			},

			Tooltip: {
				'!proto': 'Container',
				defaultSettings: {
					tooltipDelay: {
						'!type': 'number',
						'!doc': ''
					},
					tooltipEnabled: {
						'!type': 'bool',
						'!doc': ''
					},
					tooltipTransitionEffect: {
						'!type': 'string',
						'!doc': ''
					},
					titleColored: {
						'!type': 'bool',
						'!doc': ''
					}
				},
				'prototype': {
					'draw': {
						'!type': 'fn() -> ?',
						'!doc': 'Draws the tooltip and sets the event handlers for showing and hiding\n\n@param {HTMLElement} parentNode The node that this component will draw itself in\n\n@returns {HTMLElement} This component\'s outer node'
					},
					'show': {
						'!type': 'fn(event: ?) -> !this',
						'!doc': 'Shows the tooltip\n\n@param {Event} event The event object of the event handler that triggered the show\n\n@returns {_DP.ComponentTypes.Tooltip} This object'
					},
					'delayedShow': {
						'!type': 'fn(event: ?) -> !this',
						'!doc': 'Shows the tooltip (calls the show() method) after the delay period specified in the delay property has expired\n\n@param {Event} event The event object of the event handler that triggered the delayedShow\n\n@returns {_DP.ComponentTypes.Tooltip} This object'
					},
					'hide': {
						'!type': 'fn() -> !this',
						'!doc': 'Hides the tooltip\n\n@returns {_DP.ComponentTypes.Tooltip} This object'
					},
					'delayedHide': {
						'!type': 'fn() -> !this',
						'!doc': 'Hides the tooltip (calls the hide() method) after the delay period specified in the delay property has expired\n\n@returns {_DP.ComponentTypes.Tooltip} This object'
					},
					'position': {
						'!type': 'fn() -> !this',
						'!doc': 'Positions the tooltip based on the mouse location at the time the event was triggered\n\n@returns {_DP.ComponentTypes.Tooltip} This object'
					},
					'attachTo': {
						'!type': 'fn(element: ?, onShow?: +Function, context?: ?) -> !this',
						'!doc': 'Attaches the tooltip to the element and\nsets mouse or touch events (based on the device type) on showing and hiding\n\n@param {HTMLElement} element The element to attach the tooltip to\n@param {Function} [onShow] Callback\n@param {Object} [context] Context of the callback\n\n@return {Tooltip} This object'
					},
					'setText': {
						'!type': 'fn(text: ?) -> !this',
					},
					'fixPosition': {
						'!type': 'fn() -> !this',
					},
					'toggleEditMode': {
						'!type': 'fn() -> !this',
					},
					'setPosition': {
						'!type': 'fn(x: ?, y: ?) -> !this',
					},
				}
			}
		},

		_DP: {
			'!doc': 'The global namespace object',
			ComponentTypes: {
				DashboardComponent: {
					'!type': 'fn(elementID: string, settings: object)',
					'!doc': 'Base class for all Dashboard components',
					EVENT_CATEGORIES: 'DashboardComponent.EVENT_CATEGORIES',
				},
				Container: {
					TRANSITION_EFFECT: 'Container.TRANSITION_EFFECT'
				},
				Control: {
					POSITION: 'Control.POSITION'
				},
				Button: {
					SIZE: 'Button.SIZE',
					BUTTON_STYLE: 'Button.BUTTON_STYLE'
				},
				ButtonGroup: {
					ALIGNMENT: 'ButtonGroup.ALIGNMENT'
				},
				Highchart: {
					LINKVALUE: 'Highchart.LINKVALUE',
					LINKBY: 'Highchart.LINKBY',
					CHART_TYPE: 'Highchart.CHART_TYPE'
				},
				Label: {
					ALIGNMENT: 'Label.ALIGNMENT'
				},
				NestedList: {
					SELECT_STYLE: 'NestedList.SELECT_STYLE',
					ORIENTATION: 'NestedList.ORIENTATION'
				},
				Notification: {
					NOTIFICATION_TYPE: 'Notification.NOTIFICATION_TYPE'
				},
				PeriodSelector: {
					SELECTOR_STYLE: 'PeriodSelector.SELECTOR_STYLE',
					INPUTSETTING_TYPE: 'PeriodSelector.INPUTSETTING_TYPE'
				},
				Popup: {
					ANCHOR_LOCATION: 'Popup.ANCHOR_LOCATION',
					TYPE: 'Popup.TYPE'
				},
				SelectButtons: {
					ALIGNMENT: 'SelectButtons.ALIGNMENT'
				},
				TextInput: {
					INPUT_TYPE: 'TextInput.INPUT_TYPE'
				},
				Widget: {
					SIZE: 'Widget.SIZE',
					POSITION: 'Widget.POSITION'
				}
			},
			Color: {
				'!type': 'fn(red: number, green: number, blue: number, opacity: number)',
				RED: 'string',
				GREEN: 'string',
				BLUE: 'string',
				YELLOW: 'string',
				TEAL: 'string',
				PURPLE: 'string',
				BLACK: 'string',
				WHITE: 'string',
				'prototype': {
					red: {
						'!type': 'number',
						'!doc': 'Red color code 0 - 255'
					},
					green: {
						'!type': 'number',
						'!doc': 'Green color code 0 - 255'
					},
					blue: {
						'!type': 'number',
						'!doc': 'Blue color code 0 - 255'
					},
					opacity: {
						'!type': 'number',
						'!doc': 'Opacity value from 0 to 1'
					},
					toString: 'fn()',
					setRed: {
						'!type': 'fn(red:number) -> +Color',
						'!doc': 'Sets the red value of the color'
					},
					setGreen: {
						'!type': 'fn(green:number) -> +Color',
						'!doc': 'Sets the green value of the color'
					},
					setBlue: {
						'!type': 'fn(blue:number) -> +Color',
						'!doc': 'Sets the blue value of the color'
					},
					setOpacity: {
						'!type': 'fn(opacity:number) -> +Color',
						'!doc': 'Sets the opacity the color'
					},
					setAlpha: {
						'!type': 'fn(alpha:number) -> +Color',
						'!doc': 'Sets the alpha value of the color (opacity expressed in a value ranging from 0 to 255)'
					},
					setRGB: {
						'!type': 'fn(red:number, green:number, blue:number) -> +Color',
						'!doc': 'Sets the color\'s values in R,G,B format'
					},
					setRGBA: {
						'!type': 'fn(red:number, green:number, blue:number, alpha:number) -> +Color',
						'!doc': 'Sets the color\'s values in R,G,B,A format'
					},
					setHtml: {
						'!type': 'fn(htmlColor:string) -> +Color',
						'!doc': 'Sets the color\'s values in HTML ("#FFFFFF", "#FFF" or "rgb(255, 255, 255)") format.\nThe leading # for hexadecimal notation is optional.'
					},
					getHtml: {
						'!type': 'fn() -> string',
						'!doc': 'Returns the color as a string in a browser-interpretable HTML format ("#112233")'
					},
					setColor: {
						'!type': 'fn(red:number, green:number, blue:number, opacity:number) -> +Color',
						'!doc': 'Sets the color\'s values in R,G,B number or html hex format'
					},
					blend: {
						'!type': 'fn(color: Color, ration: number) -> +Color',
						'!doc': 'Blends this color with another color object and returns the blended color.'
					},
					getShades: {
						'!type': 'fn(number: number) -> +Color',
						'!doc': 'Returns color shades.'
					},
					setColorComponent: {
						'!type': 'fn(component:string, value: string) -> +Color',
						'!doc': 'Returns color shades.'
					},
					getDefinition: {
						'!type': 'fn() -> string',
						'!doc': ''
					}
				}
			},
			Data: {
				'!doc': 'the data helper classes',
				Processor: {
					INPUT_TYPES: {
						COUNT: 'string',
						CROSSTAB: 'string',
						VERBATIM: 'string',
						NORMALIZED: 'string'
					},
					OUTPUT_TYPES: {
						HIGHCHART: 'string',
						TABLE: 'string'
					},
					TIME_VARIABLE_NAME: 'string',
					CELL_PROPERTIES: {
						NUMBER: {
							propertyName: 'string',
							isPercentage: 'bool'
						},
						MEANS: {
							propertyName: 'string',
							isPercentage: 'bool'
						},
						TOPBOX: {
							propertyName: 'string',
							isPercentage: 'bool'
						},
						TOPBOXNUMBER: {
							propertyName: 'string',
							isPercentage: 'bool'
						},
						ROW: {
							propertyName: 'string',
							isPercentage: 'bool'
						},
						COLUMN: {
							propertyName: 'string',
							isPercentage: 'bool'
						},
						TOTAL: {
							propertyName: 'string',
							isPercentage: 'bool'
						}
					}
				},
				Processors: {
					Crosstable: {
						PROPERTYNAMES: {
							NUMBER: 'string',
							MEANS: 'string',
							NUMBER_UNWEIGHTED: 'string',
							POPUPLATION: 'string',
							ROW: 'string',
							COLUMN: 'string',
							STDDEV: 'string',
							TOTAL: 'string',
							SUM: 'string',
							TOPBOX: 'string'
						},
						AGGREGATION: {
							DAY: 'number',
							WEEK: 'number',
							FOURWEEKS: 'number',
							MONTH: 'number',
							QUARTER: 'number',
							HALFYEAR: 'number',
							YEAR: 'number'
						},
						AGGREGATION_PERIOD_TYPE: {
							'0.1': 'string',
							'1': 'string',
							'2': 'string',
							'3': 'string',
							'4': 'string',
							'5': 'string',
							'6': 'string'
						},
						TOTAL_ANSWER_LABEL: 'string',
						TIME_COLUMN_LABEL: 'string'
					},
					Frequencies: {
						'!type': 'fn(data, settings)',
						'!doc': 'The data processor class for frequencies data.',
						'prototype': {
							data: {
								'!doc': 'An object containing data returned by the getFrequencies DashboardService.'
							},
							series: {
								'!type': '[]',
								'!doc': ''
							},
							categories: {
								'!type': '[]',
								'!doc': ''
							},
							totals: {
								'!type': '[]',
								'!doc': ''
							},
							categoryValues: {
								'!doc': ''
							},
							seriesValues: {
								'!type': '[]',
								'!doc': ''
							},
							settings: {
								'!doc': 'settings A collection of settings that govern how data is processed.'
							}
						}
					}
				},
				RequestCache: {
					'!doc': 'stores all datarequests, so duplicate requests do not need to fire more than once'
				},
				Codebook: {
					QUESTION_TYPES: {
						INTEGER: {
							id: 'number',
							isMapped: 'bool',
							isMultiple: 'bool'
						},
						MAPPED: {
							id: 'number',
							isMapped: 'bool',
							isMultiple: 'bool'
						},
						OPEN_QUESTION: {
							id: 'number',
							isMapped: 'bool',
							isMultiple: 'bool'
						},
						MULTIPLE: {
							id: 'number',
							isMapped: 'bool',
							isMultiple: 'bool'
						},
						MAPPED_MULTIPLE: {
							id: 'number',
							isMapped: 'bool',
							isMultiple: 'bool'
						},
						INTEGER_64BIT: {
							id: 'number',
							isMapped: 'bool',
							isMultiple: 'bool'
						}
					}
				},
				Transporter: {
					properties: {
						data: '?',
						dataRequests: '?',
						dataRequestIterator: 'number',
						widget: 'Widget',
						server: 'string',
						hostName: 'string',
						callback: 'fn()',
						dataRequestStatus: '?',
						requestTimeout: 'number',
						errorHandler: 'fn()',
						filterParams: '?',
						filterParamIndex: 'number',
						useCaching: 'bool',
						inputSettings: '?',
						callbackContext: '?',
						settings: '?'
					},
					PARAMETER_FORMAT: {
						LEGACY: 'string',
						JSONRPC2: 'string'
					}
				}
			},
			Formatters: {
				'!doc': 'the formatter helper objects'
			},
			Definition: {
				Library: {
					'!doc': 'Library components'
				},
				Sites: {
					'!doc': 'static site specific definitions (Site.js)'
				},
				Custom: {
					'!doc': 'user-defined definitions (saved on server. contexts: Portal, Client, Survey, User)',
					Client: {},
					Survey: {},
					User: {}
				},
				Constructs: {
					'!type': '[]',
					'!doc': 'definition factories'
				},
				Core: {
					'!doc': 'core component definitions'
				},
				Packages: {}
			},
			Engine: {
				'!doc': 'holds the Engine object'
			},
			Globals: {
				'!doc': 'holds all globals, specifically those set by the global datarequests'
			},
			Instance: {
				'!doc': 'holds the instance of the Dashboard class'
			},
			Components: {
				'!doc': 'stores a reference to all components in the current portal'
			},
			Environment: {
				'!doc': 'reference will be replaced by reference to object with environment information provided by the back end'
			},
			version: {
				'!doc': 'replaced with the framework version by the build script'
			}
		},

		_DU: {
			PERIOD_TYPES: {
				DAY: {
					'!type': 'string'
				},
				WEEK: {
					'!type': 'string'
				},
				TWOWEEKS: {
					'!type': 'string'
				},
				FOURWEEKS: {
					'!type': 'string'
				},
				MONTH: {
					'!type': 'string'
				},
				QUARTER: {
					'!type': 'string'
				},
				HALFYEAR: {
					'!type': 'string'
				},
				YEAR: {
					'!type': 'string'
				}
			},
			size: {
				'!type': 'fn(object) -> number'
			},
			getClass: {
				'!type': 'fn(obj) -> string',
				'!doc': 'Copy of phpjs.org, retrieves the class name\n\n@param {Object} obj Object to get the class of\n@param {string} Returns The class name of the object, if unknown it returns \'Object\''
			},
			print_r: {
				'!type': 'fn(input: ?, _indent: string) -> string'
			},
			findInArray: {
				'!type': 'fn(arr: [?], val: ?) -> number',
				'!doc': 'Looks for a value inside an array and returns the element index if found.\nReturns -1 if the value is not found.\n\n@param {Array} arr The array to search in\n@param {*} val The value to search for\n\n@returns {number} The index of the element if found, otherwise -1'
			},
			removeFromArray: {
				'!type': 'fn(arr: [?], val: ?) -> !0',
				'!doc': 'Looks for a value inside an array and removes the element if found.\n\n@param {Array} arr The array to search in\n@param {mixed} val The value to search for\n\n@returns {Array} The resulting array'
			},
			cloneObject: {
				'!type': 'fn(obj: ?, condition: ?) -> +Date',
				'!doc': 'Creates an exact clone of an object, without references to the original\n\n@param {object} obj The object to clone\n@param {function} [condition] If specified, only elements of the object hierarchy that qualify for this condition will be included in the clone\n\n@returns {object} The clone'
			},
			objectsEqual: {
				'!type': 'fn(obj1: ?, obj2: ?) -> bool',
				'!doc': 'Compares two objects and returns whether they are equal.\n\n@param {object} obj1 first object for the comparison\n@param {object} obj2 second object for the comparison\n\n@returns {boolean} True if both objects are equal, false if not'
			},
			mergeObjects: {
				'!type': 'fn(obj1: ?, obj2: ?, options?: ?) -> ?',
				'!doc': 'Merges two objects (or arrays).\nFor duplicate properties, the second parameter (obj2) is leading.\nOperates recursively.\n\n@param {object} obj1 The first object to merge.\n@param {object} obj2 The second object to merge.\n@param {object} [options] Any of the following options:\n@config {boolean} [replaceIfEmpty] If true, empty (falsy) properties are never leading and will always be replaced by their non-empty counterpart.\n@config {boolean} [inPlace] If true, members of obj2 are merged directly into obj1, without making a clone of obj1.\n@config {boolean} [overwriteArrays] By default, when two arrays are encountered, the elements are combined into one array. If this option is true, the second array completely overwrites the first.\n@config {boolean} [firstLeading] If true, the first parameter will be leading instead of the second.\n\n@returns {object} The merged object.'
			},
			sortObject: {
				'!type': 'fn(obj: ?) -> object'
			},
			sortObjectByValue: {
				'!type': 'fn(obj: ?, reversed: ?) -> object'
			},
			sortObjectsByProperty: {
				'!type': 'fn(obj: ?, propertyName: string, reversed: ?) -> object'
			},
			getObjectKeys: {
				'!type': 'fn(obj: ?) -> [?]'
			},
			objectToArrayOfObjects: {
				'!type': 'fn(obj: ?, prop: string) -> [?]'
			},
			getNestedPropertyOfObject: {
				'!type': 'fn(obj: string, prop: ?) -> ?'
			},
			getNestedMember: {
				'!type': 'fn() -> string'
			},
			findObjectInArrayByPropertyValue: {
				'!type': 'fn(arr: ?, prop: ?, value: ?) -> ?'
			},
			validateEmail: {
				'!type': 'fn(elementValue: ?) -> bool'
			},
			parseDaphneDateString: {
				'!type': 'fn(dateString: string, type: string) -> number',
				'!doc': 'Returns the timestamp corresponding to a Daphne date string, adjusted for server/client timezone difference\n\n@deprecated Use Date.fromDriveString()\n\n@param {string} dateString The date string to parse\n@param {string} type The type of date, see _DU.PERIOD_TYPES\n\n@returns {number} The timestamp corresponding to the datestring, adjusted for server/client timezone difference'
			},
			getServerDate: {
				'!type': 'fn(string: ?)'
			},
			getLocalDate: {
				'!type': 'fn(timestamp: number) -> ?',
				'!doc': 'Returns a local date based on a server timestamp, adjusted for server/client timezone difference\n\n@deprecated Use Date.fromServerTimestamp\n\n@param {number} timestamp The server timestamp\n\n@returns {Date} The corresponding local date'
			},
			stripTags: {
				'!type': 'fn(str: ?) -> string'
			},
			parseImageProps: {
				'!type': 'fn(string: ?, props: [string], object: _DU.parseImageProps.!2) -> !2'
			},
			escapeRegExp: {
				'!type': 'fn(str: ?)'
			},
			isNumeric: {
				'!type': 'fn(n: ?) -> bool'
			},
			parseTime: {
				'!type': 'fn(timeString: ?, date: ?) -> !1'
			},
			parseUri: {
				'!type': 'fn(uri: string) -> _DU.parseUri.!ret'
			},
			parseDateTime: {
				'!type': 'fn(string: ?) -> number'
			},
			leftPad: {
				'!type': 'fn(string: string, pad: string) -> string'
			},
			getQueryParameters: {
				'!type': 'fn() -> ?'
			},
			getCookies: {
				'!type': 'fn() -> ?'
			},
			getCookie: {
				'!type': 'fn(name: ?)'
			},
			setCookie: {
				'!type': 'fn(name: string, value: string, end?: ?, path?: string, domain?: string, secure?: bool) -> bool',
				'!doc': '@param {string} name The name of the cookie to create/overwrite\n@param {string} value The value of the cookie\n@param {mixed} [end] Life time in days (Infinity for a never-expires cookie)\nor the expires date in GMTString format or as Date object;\n@param {string} [path] If not specified, defaults to the current path of the current document location\n@param {string} [domain] If not specified, defaults to the host portion of the current document location\n@param {boolean} [secure] The cookie will be transmitted only over secure protocol as https\n@returns {boolean}'
			},
			splitStringToObject: {
				'!type': 'fn(str: ?) -> ?'
			},
			compareObjects: {
				'!type': 'fn(obj1: ?, obj2: ?, options: ?) -> [?, ?]|?'
			},
			isEmpty: {
				'!type': 'fn(variable: ?) -> bool'
			},
			areEqual: {
				'!type': 'fn(a: ?, b: ?) -> bool'
			},
			sanitizeId: {
				'!type': 'fn(string: ?)'
			},
			arrayToObject: {
				'!type': 'fn(array: ?) -> ?'
			},
			pluckArray: {
				'!type': 'fn(arr: ?, prop: ?) -> [?]',
				'!doc': 'Deprecated: Use lodash function instead.\n\n@deprecated'
			},
			checkType: {
				'!type': 'fn(variable: string|bool, type: string, className?: string|[string]) -> bool',
				'!doc': 'Checks a variable against a type and optionally against a class.\nThe purpose of this function is parameter validation against native types and classes (e.g. Array)\nAnd not against _DP classes, like _DP.ComponentTypes.DashboardComponent, which can be validated by using instanceof directly\n\n@throws {TypeError} If the variable is not of the specified type or class\n\n@param {*} variable The variable to check\n@param {string} type The type to check against\n@param {string|function} [className] The name or constructor of the class to check against\n\n@returns {boolean} Always true, any failed validation throws an error'
			},
			removeKeyIndex: {
				'!type': 'fn(object: ?, index: ?) -> bool',
				'!doc': 'Remove a index from a object or a array, use this when you\'re not sure if the object is an array or object\n@param object target object\n@param index the index to be removed\n@returns {boolean}'
			},
			first: {
				'!type': 'fn(collection: ?) -> ?',
				'!doc': 'Return the first item in a given collection (object or array).\n\n@param {object} collection The collection to return the first item from\n\n@returns {mixed} The first item in the goven collection'
			},
			navigateToUrl: {
				'!type': 'fn(url: string) -> !this',
				'!doc': 'Nagivates the browser to the specified URL\n\n@param {string} url\n\n@returns {object} This object'
			},
			serializeObject: {
				'!type': 'fn(obj: ?, level: number) -> string'
			},
			parseVersion: {
				'!type': 'fn(version: string, includePreRelease?: bool) -> [string]',
				'!doc': 'Parses a SemVer compliant version number into an array that contains the separate segments\n\n@see http://semver.org/\n\n@param {string} version The version number\n@param {boolean} [includePreRelease=false] Whether to include the pre-release segment in the returned object\n\n@returns {Array} The parsed version number: [major, minor, patch[, pre]]'
			},
			md5: {
				'!type': 'fn(s: string) -> string',
				'!doc': 'Generate MD5 hash string\noriginally by Joseph Myers\nhttp://www.myersdaily.org/joseph/javascript/md5-text.html\n\n@param {string} s String from which to calculate hash\n\n@returns {string} Returns 32-characters hexadecimal hash string.'
			}
		}
	};

	var defs_css = {
		'!name': 'CSSStyle',
		'!define': {
			CSSStyle: {
				alignContent: {
					'!type': 'string',
					'!doc': 'Sets or returns the alignment between the lines inside a flexible container when the items do not use all available space.\n@CSS 3'
				},
				alignItems: {
					'!type': 'string',
					'!doc': 'Sets or returns the alignment for items inside a flexible container.\n@CSS 3'
				},
				alignSelf: {
					'!type': 'string',
					'!doc': 'Sets or returns the alignment for selected items inside a flexible container.\n@CSS 3'
				},
				animation: {
					'!type': 'string',
					'!doc': 'A shorthand property for all the animation properties below, except the animationPlayState property.\n@CSS 3'
				},
				animationDelay: {
					'!type': 'string',
					'!doc': 'Sets or returns when the animation will start.\n@CSS 3'
				},
				animationDirection: {
					'!type': 'string',
					'!doc': 'Sets or returns whether or not the animation should play in reverse on alternate cycles.\n@CSS 3'
				},
				animationDuration: {
					'!type': 'string',
					'!doc': 'Sets or returns how many seconds or milliseconds an animation takes to complete one cycle.\n@CSS 3'
				},
				animationFillMode: {
					'!type': 'string',
					'!doc': 'Sets or returns what values are applied by the animation outside the time it is executing.\n@CSS 3'
				},
				animationIterationCount: {
					'!type': 'string',
					'!doc': 'Sets or returns the number of times an animation should be played.\n@CSS 3'
				},
				animationName: {
					'!type': 'string',
					'!doc': 'Sets or returns a name for the @keyframes animation.\n@CSS 3'
				},
				animationTimingFunction: {
					'!type': 'string',
					'!doc': 'Sets or returns the speed curve of the animation.\n@CSS 3'
				},
				animationPlayState: {
					'!type': 'string',
					'!doc': 'Sets or returns whether the animation is running or paused.\n@CSS 3'
				},
				background: {
					'!type': 'string',
					'!doc': 'Sets or returns all the background properties in one declaration.\n@CSS 1'
				},
				backgroundAttachment: {
					'!type': 'string',
					'!doc': 'Sets or returns whether a background-image is fixed or scrolls with the page.\n@CSS 1'
				},
				backgroundColor: {
					'!type': 'string',
					'!doc': 'Sets or returns the background-color of an element.\n@CSS 1'
				},
				backgroundImage: {
					'!type': 'string',
					'!doc': 'Sets or returns the background-image for an element.\n@CSS 1'
				},
				backgroundPosition: {
					'!type': 'string',
					'!doc': 'Sets or returns the starting position of a background-image.\n@CSS 1'
				},
				backgroundRepeat: {
					'!type': 'string',
					'!doc': 'Sets or returns how to repeat (tile) a background-image.\n@CSS 1'
				},
				backgroundClip: {
					'!type': 'string',
					'!doc': 'Sets or returns the painting area of the background.\n@CSS 3'
				},
				backgroundOrigin: {
					'!type': 'string',
					'!doc': 'Sets or returns the positioning area of the background images.\n@CSS 3'
				},
				backgroundSize: {
					'!type': 'string',
					'!doc': 'Sets or returns the size of the background image.\n@CSS 3'
				},
				backfaceVisibility: {
					'!type': 'string',
					'!doc': 'Sets or returns whether or not an element should be visible when not facing the screen.\n@CSS 3'
				},
				border: {
					'!type': 'string',
					'!doc': 'Sets or returns borderWidth, borderStyle, and borderColor in one declaration.\n@CSS 1'
				},
				borderBottom: {
					'!type': 'string',
					'!doc': 'Sets or returns all the borderBottom* properties in one declaration.\n@CSS 1'
				},
				borderBottomColor: {
					'!type': 'string',
					'!doc': 'Sets or returns the color of the bottom border.\n@CSS 1 '
				},
				borderBottomLeftRadius: {
					'!type': 'string',
					'!doc': 'Sets or returns the shape of the border of the bottom-left corner.\n@CSS 3'
				},
				borderBottomRightRadius: {
					'!type': 'string',
					'!doc': 'Sets or returns the shape of the border of the bottom-right corner.\n@CSS 3'
				},
				borderBottomStyle: {
					'!type': 'string',
					'!doc': 'Sets or returns the style of the bottom border.\n@CSS 1'
				},
				borderBottomWidth: {
					'!type': 'string',
					'!doc': 'Sets or returns the width of the bottom border.\n@CSS 1'
				},
				borderCollapse: {
					'!type': 'string',
					'!doc': 'Sets or returns whether the table border should be collapsed into a single border, or not.\n@CSS 2'
				},
				borderColor: {
					'!type': 'string',
					'!doc': 'Sets or returns the color of an element\'s border (can have up to four values).\n@CSS 1'
				},
				borderImage: {
					'!type': 'string',
					'!doc': 'A shorthand property for setting or returning all the borderImage* properties.\n@CSS 3'
				},
				borderImageOutset: {
					'!type': 'string',
					'!doc': 'Sets or returns the amount by which the border image area extends beyond the border box.\n@CSS 3'
				},
				borderImageRepeat: {
					'!type': 'string',
					'!doc': 'Sets or returns whether the image-border should be repeated, rounded or stretched.\n@CSS 3'
				},
				borderImageSlice: {
					'!type': 'string',
					'!doc': 'Sets or returns the inward offsets of the image-border.\n@CSS 3'
				},
				borderImageSource: {
					'!type': 'string',
					'!doc': 'Sets or returns the image to be used as a border.\n@CSS 3'
				},
				borderImageWidth: {
					'!type': 'string',
					'!doc': 'Sets or returns the widths of the image-border.\n@CSS 3'
				},
				borderLeft: {
					'!type': 'string',
					'!doc': 'Sets or returns all the borderLeft* properties in one declaration.\n@CSS 1'
				},
				borderLeftColor: {
					'!type': 'string',
					'!doc': 'Sets or returns the color of the left border.\n@CSS 1'
				},
				borderLeftStyle: {
					'!type': 'string',
					'!doc': 'Sets or returns the style of the left border.\n@CSS 1'
				},
				borderLeftWidth: {
					'!type': 'string',
					'!doc': 'Sets or returns the width of the left border.\n@CSS 1'
				},
				borderRadius: {
					'!type': 'string',
					'!doc': 'A shorthand property for setting or returning all the four border*Radius properties.\n@CSS 3'
				},
				borderRight: {
					'!type': 'string',
					'!doc': 'Sets or returns all the borderRight* properties in one declaration.\n@CSS 1'
				},
				borderRightColor: {
					'!type': 'string',
					'!doc': 'Sets or returns the color of the right border.\n@CSS 1'
				},
				borderRightStyle: {
					'!type': 'string',
					'!doc': 'Sets or returns the style of the right border.\n@CSS 1'
				},
				borderRightWidth: {
					'!type': 'string',
					'!doc': 'Sets or returns the width of the right border.\n@CSS 1'
				},
				borderSpacing: {
					'!type': 'string',
					'!doc': 'Sets or returns the space between cells in a table.\n@CSS 2'
				},
				borderStyle: {
					'!type': 'string',
					'!doc': 'Sets or returns the style of an element\'s border (can have up to four values).\n@CSS 1'
				},
				borderTop: {
					'!type': 'string',
					'!doc': 'Sets or returns all the borderTop* properties in one declaration.\n@CSS 1'
				},
				borderTopColor: {
					'!type': 'string',
					'!doc': 'Sets or returns the color of the top border.\n@CSS 1'
				},
				borderTopLeftRadius: {
					'!type': 'string',
					'!doc': 'Sets or returns the shape of the border of the top-left corner.\n@CSS 3'
				},
				borderTopRightRadius: {
					'!type': 'string',
					'!doc': 'Sets or returns the shape of the border of the top-right corner.\n@CSS 3'
				},
				borderTopStyle: {
					'!type': 'string',
					'!doc': 'Sets or returns the style of the top border.\n@CSS 1'
				},
				borderTopWidth: {
					'!type': 'string',
					'!doc': 'Sets or returns the width of the top border.\n@CSS 1'
				},
				borderWidth: {
					'!type': 'string',
					'!doc': 'Sets or returns the width of an element\'s border (can have up to four values).\n@CSS 1'
				},
				bottom: {
					'!type': 'string',
					'!doc': 'Sets or returns the bottom position of a positioned element.\n@CSS 2'
				},
				boxDecorationBreak: {
					'!type': 'string',
					'!doc': 'Sets or returns the behaviour of the background and border of an element at page-break, or, for in-line elements, at line-break..\n@CSS 3'
				},
				boxShadow: {
					'!type': 'string',
					'!doc': 'Attaches one or more drop-shadows to the box.\n@CSS 3'
				},
				boxSizing: {
					'!type': 'string',
					'!doc': 'Allows you to define certain elements to fit an area in a certain way.\n@CSS 3'
				},
				captionSide: {
					'!type': 'string',
					'!doc': 'Sets or returns the position of the table caption.\n@CSS 2'
				},
				clear: {
					'!type': 'string',
					'!doc': 'Sets or returns the position of the element relative to floating objects.\n@CSS 1'
				},
				clip: {
					'!type': 'string',
					'!doc': 'Sets or returns which part of a positioned element is visible.\n@CSS 2'
				},
				color: {
					'!type': 'string',
					'!doc': 'Sets or returns the color of the text.\n@CSS 1'
				},
				columnCount: {
					'!type': 'string',
					'!doc': 'Sets or returns the number of columns an element should be divided into.\n@CSS 3'
				},
				columnFill: {
					'!type': 'string',
					'!doc': 'Sets or returns how to fill columns.\n@CSS 3'
				},
				columnGap: {
					'!type': 'string',
					'!doc': 'Sets or returns the gap between the columns.\n@CSS 3'
				},
				columnRule: {
					'!type': 'string',
					'!doc': 'A shorthand property for setting or returning all the columnRule* properties.\n@CSS 3'
				},
				columnRuleColor: {
					'!type': 'string',
					'!doc': 'Sets or returns the color of the rule between columns.\n@CSS 3'
				},
				columnRuleStyle: {
					'!type': 'string',
					'!doc': 'Sets or returns the style of the rule between columns.\n@CSS 3'
				},
				columnRuleWidth: {
					'!type': 'string',
					'!doc': 'Sets or returns the width of the rule between columns.\n@CSS 3'
				},
				columns: {
					'!type': 'string',
					'!doc': 'A shorthand property for setting or returning columnWidth and columnCount.\n@CSS 3'
				},
				columnSpan: {
					'!type': 'string',
					'!doc': 'Sets or returns how many columns an element should span across.\n@CSS 3'
				},
				columnWidth: {
					'!type': 'string',
					'!doc': 'Sets or returns the width of the columns.\n@CSS 3'
				},
				content: {
					'!type': 'string',
					'!doc': 'Used with the :before and :after pseudo-elements, to insert generated content.\n@CSS 2'
				},
				counterIncrement: {
					'!type': 'string',
					'!doc': 'Increments one or more counters.\n@CSS 2'
				},
				counterReset: {
					'!type': 'string',
					'!doc': 'Creates or resets one or more counters.\n@CSS 2'
				},
				cursor: {
					'!type': 'string',
					'!doc': 'Sets or returns the type of cursor to display for the mouse pointer.\n@CSS 2'
				},
				direction: {
					'!type': 'string',
					'!doc': 'Sets or returns the text direction.\n@CSS 2'
				},
				display: {
					'!type': 'string',
					'!doc': 'Sets or returns an element\'s display type.\n@CSS 1'
				},
				emptyCells: {
					'!type': 'string',
					'!doc': 'Sets or returns whether to show the border and background of empty cells, or not.\n@CSS 2'
				},
				filter: {
					'!type': 'string',
					'!doc': 'Sets or returns image filters (visual effects, like blur and saturation).\n@CSS 3'
				},
				flex: {
					'!type': 'string',
					'!doc': 'Sets or returns the length of the item, relative to the rest.\n@CSS 3'
				},
				flexBasis: {
					'!type': 'string',
					'!doc': 'Sets or returns the initial length of a flexible item.\n@CSS 3'
				},
				flexDirection: {
					'!type': 'string',
					'!doc': 'Sets or returns the direction of the flexible items.\n@CSS 3'
				},
				flexFlow: {
					'!type': 'string',
					'!doc': 'A shorthand property for the flexDirection and the flexWrap properties.\n@CSS 3'
				},
				flexGrow: {
					'!type': 'string',
					'!doc': 'Sets or returns how much the item will grow relative to the rest.\n@CSS 3'
				},
				flexShrink: {
					'!type': 'string',
					'!doc': 'Sets or returns how the item will shrink relative to the rest.\n@CSS 3'
				},
				flexWrap: {
					'!type': 'string',
					'!doc': 'Sets or returns whether the flexible items should wrap or not.\n@CSS 3'
				},
				cssFloat: {
					'!type': 'string',
					'!doc': 'Sets or returns the horizontal alignment of an element.\n@CSS 1'
				},
				font: {
					'!type': 'string',
					'!doc': 'Sets or returns fontStyle, fontVariant, fontWeight, fontSize, lineHeight, and fontFamily in one declaration.\n@CSS 1'
				},
				fontFamily: {
					'!type': 'string',
					'!doc': 'Sets or returns the font family for text.\n@CSS 1'
				},
				fontSize: {
					'!type': 'string',
					'!doc': 'Sets or returns the font size of the text.\n@CSS 1'
				},
				fontStyle: {
					'!type': 'string',
					'!doc': 'Sets or returns whether the style of the font is normal, italic or oblique.\n@CSS 1'
				},
				fontVariant: {
					'!type': 'string',
					'!doc': 'Sets or returns whether the font should be displayed in small capital letters.\n@CSS 1'
				},
				fontWeight: {
					'!type': 'string',
					'!doc': 'Sets or returns the boldness of the font.\n@CSS 1'
				},
				fontSizeAdjust: {
					'!type': 'string',
					'!doc': 'Preserves the readability of text when font fallback occurs.\n@CSS 3'
				},
				fontStretch: {
					'!type': 'string',
					'!doc': 'Selects a normal, condensed, or expanded face from a font family.\n@CSS 3'
				},
				hangingPunctuation: {
					'!type': 'string',
					'!doc': 'Specifies whether a punctuation character may be placed outside the line box.\n@CSS 3'
				},
				height: {
					'!type': 'string',
					'!doc': 'Sets or returns the height of an element.\n@CSS 1'
				},
				hyphens: {
					'!type': 'string',
					'!doc': 'Sets how to split words to improve the layout of paragraphs.\n@CSS 3'
				},
				icon: {
					'!type': 'string',
					'!doc': 'Provides the author the ability to style an element with an iconic equivalent.\n@CSS 3'
				},
				imageOrientation: {
					'!type': 'string',
					'!doc': 'Specifies a rotation in the right or clockwise direction that a user agent applies to an image.\n@CSS 3'
				},
				justifyContent: {
					'!type': 'string',
					'!doc': 'Sets or returns the alignment between the items inside a flexible container when the items do not use all available space..\n@CSS 3'
				},
				left: {
					'!type': 'string',
					'!doc': 'Sets or returns the left position of a positioned element.\n@CSS 2'
				},
				letterSpacing: {
					'!type': 'string',
					'!doc': 'Sets or returns the space between characters in a text.\n@CSS 1'
				},
				lineHeight: {
					'!type': 'string',
					'!doc': 'Sets or returns the distance between lines in a text.\n@CSS 1'
				},
				listStyle: {
					'!type': 'string',
					'!doc': 'Sets or returns listStyleImage, listStylePosition, and listStyleType in one declaration.\n@CSS 1'
				},
				listStyleImage: {
					'!type': 'string',
					'!doc': 'Sets or returns an image as the list-item marker.\n@CSS 1'
				},
				listStylePosition: {
					'!type': 'string',
					'!doc': 'Sets or returns the position of the list-item marker.\n@CSS 1'
				},
				listStyleType: {
					'!type': 'string',
					'!doc': 'Sets or returns the list-item marker type.\n@CSS 1'
				},
				margin: {
					'!type': 'string',
					'!doc': 'Sets or returns the margins of an element (can have up to four values).\n@CSS 1'
				},
				marginBottom: {
					'!type': 'string',
					'!doc': 'Sets or returns the bottom margin of an element.\n@CSS 1'
				},
				marginLeft: {
					'!type': 'string',
					'!doc': 'Sets or returns the left margin of an element.\n@CSS 1'
				},
				marginRight: {
					'!type': 'string',
					'!doc': 'Sets or returns the right margin of an element.\n@CSS 1'
				},
				marginTop: {
					'!type': 'string',
					'!doc': 'Sets or returns the top margin of an element.\n@CSS 1'
				},
				maxHeight: {
					'!type': 'string',
					'!doc': 'Sets or returns the maximum height of an element.\n@CSS 2'
				},
				maxWidth: {
					'!type': 'string',
					'!doc': 'Sets or returns the maximum width of an element.\n@CSS 2'
				},
				minHeight: {
					'!type': 'string',
					'!doc': 'Sets or returns the minimum height of an element.\n@CSS 2'
				},
				minWidth: {
					'!type': 'string',
					'!doc': 'Sets or returns the minimum width of an element.\n@CSS 2'
				},
				navDown: {
					'!type': 'string',
					'!doc': 'Sets or returns where to navigate when using the arrow-down navigation key.\n@CSS 3'
				},
				navIndex: {
					'!type': 'string',
					'!doc': 'Sets or returns the tabbing order for an element.\n@CSS 3'
				},
				navLeft: {
					'!type': 'string',
					'!doc': 'Sets or returns where to navigate when using the arrow-left navigation key.\n@CSS 3'
				},
				navRight: {
					'!type': 'string',
					'!doc': 'Sets or returns where to navigate when using the arrow-right navigation key.\n@CSS 3'
				},
				navUp: {
					'!type': 'string',
					'!doc': 'Sets or returns where to navigate when using the arrow-up navigation key.\n@CSS 3'
				},
				opacity: {
					'!type': 'string',
					'!doc': 'Sets or returns the opacity level for an element.\n@CSS 3'
				},
				order: {
					'!type': 'string',
					'!doc': 'Sets or returns the order of the flexible item, relative to the rest.\n@CSS 3'
				},
				orphans: {
					'!type': 'string',
					'!doc': 'Sets or returns the minimum number of lines for an element that must be left at the bottom of a page when a page break occurs inside an element.\n@CSS 2'
				},
				outline: {
					'!type': 'string',
					'!doc': 'Sets or returns all the outline properties in one declaration.\n@CSS 2'
				},
				outlineColor: {
					'!type': 'string',
					'!doc': 'Sets or returns the color of the outline around a element.\n@CSS 2'
				},
				outlineOffset: {
					'!type': 'string',
					'!doc': 'Offsets an outline, and draws it beyond the border edge.\n@CSS 3'
				},
				outlineStyle: {
					'!type': 'string',
					'!doc': 'Sets or returns the style of the outline around an element.\n@CSS 2'
				},
				outlineWidth: {
					'!type': 'string',
					'!doc': 'Sets or returns the width of the outline around an element.\n@CSS 2'
				},
				overflow: {
					'!type': 'string',
					'!doc': 'Sets or returns what to do with content that renders outside the element box.\n@CSS 2'
				},
				overflowX: {
					'!type': 'string',
					'!doc': 'Specifies what to do with the left/right edges of the content, if it overflows the element\'s content area.\n@CSS 3'
				},
				overflowY: {
					'!type': 'string',
					'!doc': 'Specifies what to do with the top/bottom edges of the content, if it overflows the element\'s content area.\n@CSS 3'
				},
				padding: {
					'!type': 'string',
					'!doc': 'Sets or returns the padding of an element (can have up to four values).\n@CSS 1'
				},
				paddingBottom: {
					'!type': 'string',
					'!doc': 'Sets or returns the bottom padding of an element.\n@CSS 1'
				},
				paddingLeft: {
					'!type': 'string',
					'!doc': 'Sets or returns the left padding of an element.\n@CSS 1'
				},
				paddingRight: {
					'!type': 'string',
					'!doc': 'Sets or returns the right padding of an element.\n@CSS 1'
				},
				paddingTop: {
					'!type': 'string',
					'!doc': 'Sets or returns the top padding of an element.\n@CSS 1'
				},
				pageBreakAfter: {
					'!type': 'string',
					'!doc': 'Sets or returns the page-break behavior after an element.\n@CSS 2'
				},
				pageBreakBefore: {
					'!type': 'string',
					'!doc': 'Sets or returns the page-break behavior before an element.\n@CSS 2'
				},
				pageBreakInside: {
					'!type': 'string',
					'!doc': 'Sets or returns the page-break behavior inside an element.\n@CSS 2'
				},
				perspective: {
					'!type': 'string',
					'!doc': 'Sets or returns the perspective on how 3D elements are viewed.\n@CSS 3'
				},
				perspectiveOrigin: {
					'!type': 'string',
					'!doc': 'Sets or returns the bottom position of 3D elements.\n@CSS 3'
				},
				position: {
					'!type': 'string',
					'!doc': 'Sets or returns the type of positioning method used for an element (static, relative, absolute or fixed).\n@CSS 2'
				},
				quotes: {
					'!type': 'string',
					'!doc': 'Sets or returns the type of quotation marks for embedded quotations.\n@CSS 2'
				},
				resize: {
					'!type': 'string',
					'!doc': 'Sets or returns whether or not an element is resizable by the user.\n@CSS 3'
				},
				right: {
					'!type': 'string',
					'!doc': 'Sets or returns the right position of a positioned element.\n@CSS 2'
				},
				tableLayout: {
					'!type': 'string',
					'!doc': 'Sets or returns the way to lay out table cells, rows, and columns.\n@CSS 2'
				},
				tabSize: {
					'!type': 'string',
					'!doc': 'Sets or returns the length of the tab-character.\n@CSS 3'
				},
				textAlign: {
					'!type': 'string',
					'!doc': 'Sets or returns the horizontal alignment of text.\n@CSS 1'
				},
				textAlignLast: {
					'!type': 'string',
					'!doc': 'Sets or returns how the last line of a block or a line right before a forced line break is aligned when text-align is "justify".\n@CSS 3'
				},
				textDecoration: {
					'!type': 'string',
					'!doc': 'Sets or returns the decoration of a text.\n@CSS 1'
				},
				textDecorationColor: {
					'!type': 'string',
					'!doc': 'Sets or returns the color of the text-decoration.\n@CSS 3'
				},
				textDecorationLine: {
					'!type': 'string',
					'!doc': 'Sets or returns the type of line in a text-decoration.\n@CSS 3'
				},
				textDecorationStyle: {
					'!type': 'string',
					'!doc': 'Sets or returns the style of the line in a text decoration.\n@CSS 3'
				},
				textIndent: {
					'!type': 'string',
					'!doc': 'Sets or returns the indentation of the first line of text.\n@CSS 1'
				},
				textJustify: {
					'!type': 'string',
					'!doc': 'Sets or returns the justification method used when text-align is "justify".\n@CSS 3'
				},
				textOverflow: {
					'!type': 'string',
					'!doc': 'Sets or returns what should happen when text overflows the containing element.\n@CSS 3'
				},
				textShadow: {
					'!type': 'string',
					'!doc': 'Sets or returns the shadow effect of a text.\n@CSS 3'
				},
				textTransform: {
					'!type': 'string',
					'!doc': 'Sets or returns the capitalization of a text.\n@CSS 1'
				},
				top: {
					'!type': 'string',
					'!doc': 'Sets or returns the top position of a positioned element.\n@CSS 2'
				},
				transform: {
					'!type': 'string',
					'!doc': 'Applies a 2D or 3D transformation to an element.\n@CSS 3'
				},
				transformOrigin: {
					'!type': 'string',
					'!doc': 'Sets or returns the position of transformed elements.\n@CSS 3'
				},
				transformStyle: {
					'!type': 'string',
					'!doc': 'Sets or returns how nested elements are rendered in 3D space.\n@CSS 3'
				},
				transition: {
					'!type': 'string',
					'!doc': 'A shorthand property for setting or returning the four transition properties.\n@CSS 3'
				},
				transitionProperty: {
					'!type': 'string',
					'!doc': 'Sets or returns the CSS property that the transition effect is for.\n@CSS 3'
				},
				transitionDuration: {
					'!type': 'string',
					'!doc': 'Sets or returns how many seconds or milliseconds a transition effect takes to complete.\n@CSS 3'
				},
				transitionTimingFunction: {
					'!type': 'string',
					'!doc': 'Sets or returns the speed curve of the transition effect.\n@CSS 3'
				},
				transitionDelay: {
					'!type': 'string',
					'!doc': 'Sets or returns when the transition effect will start.\n@CSS 3'
				},
				unicodeBidi: {
					'!type': 'string',
					'!doc': 'Sets or returns whether the text should be overridden to support multiple languages in the same document.\n@CSS 2'
				},
				verticalAlign: {
					'!type': 'string',
					'!doc': 'Sets or returns the vertical alignment of the content in an element.\n@CSS 1'
				},
				visibility: {
					'!type': 'string',
					'!doc': 'Sets or returns whether an element should be visible.\n@CSS 2'
				},
				whiteSpace: {
					'!type': 'string',
					'!doc': 'Sets or returns how to handle tabs, line breaks and whitespace in a text.\n@CSS 1'
				},
				width: {
					'!type': 'string',
					'!doc': 'Sets or returns the width of an element.\n@CSS 1'
				},
				wordBreak: {
					'!type': 'string',
					'!doc': 'Sets or returns line breaking rules for non-CJK scripts.\n@CSS 3'
				},
				wordSpacing: {
					'!type': 'string',
					'!doc': 'Sets or returns the spacing between words in a text.\n@CSS 1'
				},
				wordWrap: {
					'!type': 'string',
					'!doc': 'Allows long, unbreakable words to be broken and wrap to the next line.\n@CSS 3'
				},
				widows: {
					'!type': 'string',
					'!doc': 'Sets or returns the minimum number of lines for an element that must be visible at the top of a page.\n@CSS 2'
				},
				zIndex: {
					'!type': 'string',
					'!doc': 'Sets or returns the stack order of a positioned element.\n@CSS 2'
				}
			}
		}
	};
});
