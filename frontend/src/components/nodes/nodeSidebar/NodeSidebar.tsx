import React, { useState, useEffect, useCallback } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { RootState } from '../../../store/store'
import {
    updateNodeConfigOnly,
    selectNodeById,
    setSidebarWidth,
    setSelectedNode,
    FlowWorkflowNode,
    FlowWorkflowNodeConfig,
    updateNodeTitle,
} from '../../../store/flowSlice'
import { FlowWorkflowNodeType, FlowWorkflowNodeTypesByCategory } from '../../../store/nodeTypesSlice'
import { FieldMetadata, ModelConstraints } from '../../../types/api_types/modelMetadataSchemas'
import NumberInput from '../../NumberInput'
import CodeEditor from '../../CodeEditor'
import { jsonOptions } from '../../../constants/jsonOptions'
import FewShotEditor from '../../textEditor/FewShotEditor'
import TextEditor from '../../textEditor/TextEditor'
import {
    Button,
    Slider,
    Switch,
    Textarea,
    Input,
    Select,
    SelectItem,
    SelectSection,
    Accordion,
    AccordionItem,
    Card,
    Alert,
    Tooltip,
} from '@heroui/react'
import { Icon } from '@iconify/react'
import NodeOutput from '../NodeOutputDisplay'
import SchemaEditor from './SchemaEditor'
import { selectPropertyMetadata } from '../../../store/nodeTypesSlice'
import { cloneDeep, set, debounce } from 'lodash'
import isEqual from 'lodash/isEqual'
import { convertToPythonVariableName } from '@/utils/variableNameUtils'
// Define types for props and state
interface NodeSidebarProps {
    nodeID: string
}

// Update findNodeSchema to use imported types
const findNodeSchema = (nodeType: string, nodeTypes: FlowWorkflowNodeTypesByCategory): FlowWorkflowNodeType | null => {
    if (!nodeTypes) return null

    for (const category in nodeTypes) {
        const nodeSchema = nodeTypes[category]?.find((n: FlowWorkflowNodeType) => n.name === nodeType)
        if (nodeSchema) {
            return nodeSchema
        }
    }
    return null
}

const nodeComparator = (prevNode: FlowWorkflowNode, nextNode: FlowWorkflowNode) => {
    if (!prevNode || !nextNode) return false
    // Skip position and measured properties when comparing nodes
    const { position: prevPosition, measured: prevMeasured, ...prevRest } = prevNode
    const { position: nextPosition, measured: nextMeasured, ...nextRest } = nextNode
    return isEqual(prevRest, nextRest)
}

const nodesComparator = (prevNodes: FlowWorkflowNode[], nextNodes: FlowWorkflowNode[]) => {
    if (!prevNodes || !nextNodes) return false
    if (prevNodes.length !== nextNodes.length) return false
    return prevNodes.every((node, index) => nodeComparator(node, nextNodes[index]))
}

// Add this helper function near the top of the file, after other utility functions
const extractSchemaFromJsonSchema = (jsonSchema: string): Record<string, string> | null => {
    try {
        // First try to parse the string directly
        let parsed: Record<string, any>
        try {
            parsed = JSON.parse(jsonSchema.trim())
        } catch {
            try {
                // cleaning is required for some escaped characters
                let cleaned = jsonSchema
                    .replace(/\\"/g, '"') // Replace escaped quotes
                    .replace(/\\\[/g, '[') // Replace escaped brackets
                    .replace(/\\\]/g, ']')
                    .replace(/\\n/g, '') // Remove newlines
                    .replace(/\\t/g, '') // Remove tabs
                    .replace(/\\/g, '') // Remove remaining backslashes
                    .trim()
                parsed = JSON.parse(cleaned.trim())
            } catch {
                return null
            }
        }

        if (parsed.properties) {
            const schema: Record<string, string> = {}
            for (const [key, value] of Object.entries(parsed.properties)) {
                if (typeof value === 'object' && 'type' in value) {
                    schema[key] = (value as { type: string }).type
                }
            }
            return Object.keys(schema).length > 0 ? schema : null
        }
        return null
    } catch (error) {
        console.error('Error parsing JSON schema:', error)
        return null
    }
}

// Add this helper function near the top, after extractSchemaFromJsonSchema
const generateJsonSchemaFromSchema = (schema: Record<string, string>): string | null => {
    if (!schema || Object.keys(schema).length === 0) return null

    try {
        const jsonSchema = {
            type: 'object',
            required: Object.keys(schema),
            properties: {} as Record<string, { type: string }>,
        }

        for (const [key, type] of Object.entries(schema)) {
            if (!key || !type) return null
            jsonSchema.properties[key] = { type }
        }

        return JSON.stringify(jsonSchema, null, 2)
    } catch (error) {
        console.error('Error generating JSON schema:', error)
        return null
    }
}

// Add this function after the existing helper functions and before the NodeSidebar component
const getModelConstraints = (nodeSchema: FlowWorkflowNodeType | null, modelId: string): ModelConstraints | null => {
    if (!nodeSchema || !nodeSchema.model_constraints || !nodeSchema.model_constraints[modelId]) {
        return null
    }
    return nodeSchema.model_constraints[modelId]
}

const NodeSidebar: React.FC<NodeSidebarProps> = ({ nodeID }) => {
    const dispatch = useDispatch()
    const nodes = useSelector((state: RootState) => state.flow.nodes, nodesComparator)
    const edges = useSelector((state: RootState) => state.flow.edges, isEqual)
    const nodeTypes = useSelector((state: RootState) => state.nodeTypes.data)
    const nodeTypesMetadata = useSelector((state: RootState) => state.nodeTypes).metadata
    const node = useSelector((state: RootState) => selectNodeById(state, nodeID))
    const storedWidth = useSelector((state: RootState) => state.flow.sidebarWidth)
    const nodeConfig = useSelector((state: RootState) => state.flow.nodeConfigs[nodeID])
    const allNodeConfigs = useSelector((state: RootState) => state.flow.nodeConfigs)

    const hasRunOutput = !!node?.data?.run

    const [width, setWidth] = useState<number>(storedWidth)
    const [isResizing, setIsResizing] = useState<boolean>(false)

    const [nodeType, setNodeType] = useState<string>(node?.type || 'ExampleNode')
    const [nodeSchema, setNodeSchema] = useState<FlowWorkflowNodeType | null>(
        findNodeSchema(node?.type || 'ExampleNode', nodeTypes)
    )
    const [currentNodeConfig, setCurrentNodeConfig] = useState<FlowWorkflowNodeConfig>(nodeConfig || {})
    const [fewShotIndex, setFewShotIndex] = useState<number | null>(null)
    const [showTitleError, setShowTitleError] = useState(false)

    const collectIncomingSchema = (nodeID: string): string[] => {
        const incomingEdges = edges.filter((edge) => edge.target === nodeID)
        const incomingNodes = incomingEdges.map((edge) => nodes.find((n) => n.id === edge.source))
        // foreach incoming node, get the output schema
        // return ['nodeTitle.foo', 'nodeTitle.bar', 'nodeTitle.baz',...]
        return incomingNodes.reduce((acc: string[], node) => {
            if (!node) return acc
            const config = allNodeConfigs[node.id]
            if (config?.output_schema) {
                const nodeTitle = config.title || node.id
                return [...acc, ...Object.keys(config.output_schema).map((key) => `${nodeTitle}.${key}`)]
            }
            return acc
        }, [])
    }
    const [incomingSchema, setIncomingSchema] = useState<string[]>(collectIncomingSchema(nodeID))

    useEffect(() => {
        setIncomingSchema(collectIncomingSchema(nodeID))
    }, [nodeID, nodes, edges])

    // Create a debounced version of the dispatch update
    const debouncedDispatch = useCallback(
        debounce((id: string, updatedModel: FlowWorkflowNodeConfig) => {
            dispatch(updateNodeConfigOnly({ id, data: updatedModel }))
        }, 300),
        [dispatch]
    )

    // Update the existing useEffect to initialize LLM nodes with a default model
    useEffect(() => {
        if (node) {
            setNodeType(node.type || 'ExampleNode')
            setNodeSchema(findNodeSchema(node.type || 'ExampleNode', nodeTypes))

            // Initialize the model with a default value for LLM nodes
            let initialConfig = nodeConfig || {}
            if (node.type === 'LLMNode' || node.type === 'SingleLLMCallNode') {
                initialConfig = {
                    ...initialConfig,
                    llm_info: {
                        ...initialConfig.llm_info,
                        model: initialConfig.llm_info?.model || 'gpt-4o', // Set default model
                    },
                }
            }

            setCurrentNodeConfig(initialConfig)
        }
    }, [nodeID, node, nodeTypes, nodeConfig]) // nodeConfig dependency handles updates

    // Helper function to update nested object by path
    const updateNestedModel = (obj: FlowWorkflowNodeConfig, path: string, value: any): FlowWorkflowNodeConfig => {
        const deepClone = cloneDeep(obj)
        set(deepClone, path, value)
        return deepClone
    }

    // Update the input change handler to use local state immediately but debounce Redux updates for Slider
    const handleInputChange = (key: string, value: any, isSlider: boolean = false) => {
        let updatedModel: FlowWorkflowNodeConfig

        if (key.includes('.')) {
            updatedModel = updateNestedModel(currentNodeConfig, key, value) as FlowWorkflowNodeConfig
        } else {
            updatedModel = {
                ...currentNodeConfig,
                [key]: value,
            } as FlowWorkflowNodeConfig
        }

        // Update local state first
        setCurrentNodeConfig(updatedModel)

        // Then update Redux store
        if (isSlider) {
            debouncedDispatch(nodeID, updatedModel)
        } else {
            dispatch(updateNodeConfigOnly({ id: nodeID, data: updatedModel }))
        }
    }

    // Simplify the title change handlers into a single function
    const handleTitleChangeComplete = (value: string) => {
        const validTitle = convertToPythonVariableName(value)
        dispatch(updateNodeTitle({ nodeId: nodeID, newTitle: validTitle }))
    }

    // Update the renderEnumSelect function's model selection handler
    const renderEnumSelect = (
        key: string,
        label: string,
        enumValues: string[],
        fullPath: string,
        defaultSelected?: string
    ) => {
        const lastTwoDots = fullPath.split('.').slice(-2).join('.')

        // Special handling for LLM model selection
        if (key === 'model' && fullPath.includes('llm_info')) {
            // Group models by provider
            const modelsByProvider: {
                [key: string]: { id: string; name: string }[]
            } = {
                OpenAI: [],
                Anthropic: [],
                Google: [],
                Deepseek: [],
                Ollama: [],
            }

            enumValues.forEach((modelId) => {
                if (modelId.startsWith('ollama/')) {
                    modelsByProvider.Ollama.push({
                        id: modelId,
                        name: modelId.replace('ollama/', ''),
                    })
                } else if (modelId.startsWith('claude')) {
                    modelsByProvider.Anthropic.push({ id: modelId, name: modelId })
                } else if (modelId.startsWith('gemini')) {
                    modelsByProvider.Google.push({ id: modelId, name: modelId })
                } else if (modelId.startsWith('deepseek')) {
                    modelsByProvider.Deepseek.push({ id: modelId, name: modelId })
                } else {
                    modelsByProvider.OpenAI.push({ id: modelId, name: modelId })
                }
            })

            // Ensure we have a valid default value
            const currentValue = currentNodeConfig?.llm_info?.model || defaultSelected || 'gpt-4o'

            return (
                <div key={key}>
                    <Select
                        key={`select-${nodeID}-${key}`}
                        label={label}
                        selectedKeys={[currentValue]}
                        onChange={(e) => {
                            const selectedModelId = e.target.value
                            // Get constraints for the selected model
                            const modelConstraints = getModelConstraints(nodeSchema, selectedModelId)

                            // Create updated model config with new constraints
                            const updatedModel = {
                                ...currentNodeConfig,
                                llm_info: {
                                    ...currentNodeConfig.llm_info,
                                    model: selectedModelId,
                                    // Apply model constraints
                                    ...(modelConstraints && {
                                        max_tokens: Math.min(
                                            currentNodeConfig.llm_info?.max_tokens || modelConstraints.max_tokens,
                                            modelConstraints.max_tokens
                                        ),
                                        temperature: Math.min(
                                            Math.max(
                                                currentNodeConfig.llm_info?.temperature || 0.7,
                                                modelConstraints.min_temperature
                                            ),
                                            modelConstraints.max_temperature
                                        ),
                                    }),
                                },
                            }
                            setCurrentNodeConfig(updatedModel)
                            dispatch(updateNodeConfigOnly({ id: nodeID, data: updatedModel }))
                        }}
                        fullWidth
                    >
                        {Object.entries(modelsByProvider).map(
                            ([provider, models], index) =>
                                models.length > 0 && (
                                    <SelectSection
                                        key={`provider-${provider}`}
                                        title={provider}
                                        showDivider={index < Object.keys(modelsByProvider).length - 1}
                                    >
                                        {models.map((model) => (
                                            <SelectItem key={model.id} value={model.id}>
                                                {model.name}
                                            </SelectItem>
                                        ))}
                                    </SelectSection>
                                )
                        )}
                    </Select>
                </div>
            )
        }

        // Default rendering for other enum fields
        const currentValue = defaultSelected || currentNodeConfig[key] || enumValues[0]
        return (
            <div key={key}>
                <Select
                    key={`select-${nodeID}-${key}`}
                    label={key}
                    selectedKeys={[currentValue]}
                    onChange={(e) => handleInputChange(key, e.target.value)}
                    fullWidth
                >
                    {enumValues.map((option) => (
                        <SelectItem key={option} value={option}>
                            {option}
                        </SelectItem>
                    ))}
                </Select>
            </div>
        )
    }

    const handleAddNewExample = () => {
        const updatedExamples = [...(currentNodeConfig?.few_shot_examples || []), { input: '', output: '' }]
        handleInputChange('few_shot_examples', updatedExamples)
        setFewShotIndex(updatedExamples.length - 1)
    }

    const handleDeleteExample = (index: number) => {
        const updatedExamples = [...(currentNodeConfig?.few_shot_examples || [])]
        updatedExamples.splice(index, 1)
        handleInputChange('few_shot_examples', updatedExamples)
    }

    // Update the `getFieldMetadata` function
    const getFieldMetadata = (fullPath: string): FieldMetadata | undefined => {
        return selectPropertyMetadata(
            {
                nodeTypes: { data: nodeTypes, metadata: nodeTypesMetadata },
            } as unknown as RootState,
            fullPath
        ) as FieldMetadata
    }

    const initializeOutputJsonSchema = () => {
        const jsonSchema = generateJsonSchemaFromSchema(nodeConfig.output_schema)
        if (jsonSchema) {
            const updates = {
                output_json_schema: jsonSchema,
            }
            setCurrentNodeConfig((prev) => ({
                ...prev,
                ...updates,
            }))
            dispatch(
                updateNodeConfigOnly({
                    id: nodeID,
                    data: {
                        ...currentNodeConfig,
                        ...updates,
                    },
                })
            )
        }
    }

    useEffect(() => {
        if (nodeConfig.output_schema && !currentNodeConfig.output_json_schema) {
            initializeOutputJsonSchema()
        }
    }, [])

    // Update the `renderField` function to include missing cases
    const renderField = (key: string, field: any, value: any, parentPath: string = '', isLast: boolean = false) => {
        const fullPath = `${parentPath ? `${parentPath}.` : ''}${key}`
        const fieldMetadata = getFieldMetadata(fullPath) as FieldMetadata

        // Skip api_base field if the selected model is not an Ollama model
        if (key === 'api_base') {
            const modelValue = currentNodeConfig?.llm_info?.model
            if (!modelValue || !modelValue.toString().startsWith('ollama/')) {
                return null
            }
            // Add default value for Ollama models
            return (
                <div key={key} className="my-4">
                    <Input
                        key={`input-${nodeID}-${key}`}
                        fullWidth
                        label={fieldMetadata?.title || key}
                        value={value || 'http://localhost:11434'}
                        onChange={(e) => handleInputChange(key, e.target.value)}
                        placeholder="Enter API base URL"
                    />
                    {!isLast && <hr className="my-2" />}
                </div>
            )
        }

        // Handle enum fields
        if (fieldMetadata?.enum) {
            const defaultSelected = value || fieldMetadata.default
            return renderEnumSelect(key, fieldMetadata.title || key, fieldMetadata.enum, fullPath, defaultSelected)
        }

        if (key === 'output_schema') {
            // Get model constraints to check if JSON output is supported
            const modelConstraints = getModelConstraints(nodeSchema, currentNodeConfig?.llm_info?.model)
            const supportsJsonOutput = modelConstraints?.supports_JSON_output ?? true

            return (
                <div key={key} className="my-2">
                    <div className="flex items-center gap-2 mb-2">
                        <h3 className="font-semibold">Output Schema</h3>
                        <Tooltip
                            content={
                                supportsJsonOutput
                                    ? "The Output Schema defines the structure of this node's output. It helps ensure consistent data flow between nodes and enables type checking. Define the expected fields and their types (string, number, boolean, object, etc.)."
                                    : "This model only supports a fixed output schema with a single 'output' field of type string. Schema editing is disabled."
                            }
                            placement="left-start"
                            showArrow={true}
                            className="max-w-xs"
                        >
                            <Icon
                                icon="solar:question-circle-linear"
                                className="text-default-400 cursor-help"
                                width={20}
                            />
                        </Tooltip>
                    </div>
                    {supportsJsonOutput ? (
                        <SchemaEditor
                            key={`schema-editor-output-${nodeID}`}
                            jsonValue={currentNodeConfig.output_schema || {}}
                            onChange={(newValue) => {
                                if (Object.keys(newValue).length === 0) {
                                    // If schema is empty, just update output_schema
                                    handleInputChange('output_schema', newValue)
                                    return
                                }

                                // Try to generate JSON schema
                                const jsonSchema = generateJsonSchemaFromSchema(newValue)
                                if (jsonSchema) {
                                    // Update both if valid
                                    const updates = {
                                        output_schema: newValue,
                                        output_json_schema: jsonSchema,
                                    }
                                    setCurrentNodeConfig((prev) => ({
                                        ...prev,
                                        ...updates,
                                    }))
                                    dispatch(
                                        updateNodeConfigOnly({
                                            id: nodeID,
                                            data: {
                                                ...currentNodeConfig,
                                                ...updates,
                                            },
                                        })
                                    )
                                } else {
                                    // Update only output_schema if JSON schema generation fails
                                    handleInputChange('output_schema', newValue)
                                }
                            }}
                            options={jsonOptions}
                            schemaType="output_schema"
                            nodeId={nodeID}
                        />
                    ) : (
                        <Alert className="mb-2" color="warning">
                            <div className="flex items-center gap-2">
                                <Icon icon="solar:info-circle-linear" width={20} />
                                <span>
                                    This model uses a fixed output schema: <code>{'{ output: string }'}</code>
                                </span>
                            </div>
                        </Alert>
                    )}
                    {!isLast && <hr className="my-2" />}
                </div>
            )
        }

        if (key === 'output_json_schema') {
            // Get model constraints to check if JSON output is supported
            const modelConstraints = getModelConstraints(nodeSchema, currentNodeConfig?.llm_info?.model)
            const supportsJsonOutput = modelConstraints?.supports_JSON_output ?? true

            return (
                <div key={key}>
                    <div className="flex items-center gap-2 mb-2">
                        <h3 className="font-semibold">Output JSON Schema</h3>
                        <Tooltip
                            content={
                                supportsJsonOutput
                                    ? "The Output JSON Schema defines the structure of this node's output in JSON Schema format. This allows for more complex validation rules and nested data structures. Output Schema is ignored if Output JSON Schema is provided."
                                    : "This model only supports a fixed output schema with a single 'output' field of type string. Schema editing is disabled."
                            }
                            placement="left-start"
                            showArrow={true}
                            className="max-w-xs"
                        >
                            <Icon
                                icon="solar:question-circle-linear"
                                className="text-default-400 cursor-help"
                                width={20}
                            />
                        </Tooltip>
                    </div>
                    {supportsJsonOutput ? (
                        <CodeEditor
                            key={`text-editor-output-json-schema-${nodeID}`}
                            code={currentNodeConfig[key] || ''}
                            mode="json"
                            onChange={(value: string) => {
                                if (!value.trim()) {
                                    // If JSON schema is empty, just update output_json_schema
                                    handleInputChange('output_json_schema', value)
                                    return
                                }

                                // Try to extract simple schema
                                const simpleSchema = extractSchemaFromJsonSchema(value)
                                if (simpleSchema) {
                                    // Update both if valid
                                    const updates = {
                                        output_json_schema: value,
                                        output_schema: simpleSchema,
                                    }
                                    setCurrentNodeConfig((prev) => ({
                                        ...prev,
                                        ...updates,
                                    }))
                                    dispatch(
                                        updateNodeConfigOnly({
                                            id: nodeID,
                                            data: {
                                                ...currentNodeConfig,
                                                ...updates,
                                            },
                                        })
                                    )
                                } else {
                                    // Update only output_json_schema if schema extraction fails
                                    handleInputChange('output_json_schema', value)
                                }
                            }}
                        />
                    ) : (
                        <Alert className="mb-2" color="warning">
                            <div className="flex items-center gap-2">
                                <Icon icon="solar:info-circle-linear" width={20} />
                                <span>
                                    This model uses a fixed output schema:{' '}
                                    <code>
                                        {
                                            "{ type: 'object', properties: { output: { type: 'string' } }, required: ['output'] }"
                                        }
                                    </code>
                                </span>
                            </div>
                        </Alert>
                    )}
                    {!isLast && <hr className="my-2" />}
                </div>
            )
        }

        if (key === 'system_message') {
            return (
                <div key={key}>
                    <div className="flex items-center gap-2 mb-2">
                        <h3 className="font-semibold">System Message</h3>
                        <Tooltip
                            content="The System Message sets the AI's behavior, role, and constraints. It's like giving the AI its job description and rules to follow. Use it to define the tone, format, and any specific requirements for the responses."
                            placement="left-start"
                            showArrow={true}
                            className="max-w-xs"
                        >
                            <Icon
                                icon="solar:question-circle-linear"
                                className="text-default-400 cursor-help"
                                width={20}
                            />
                        </Tooltip>
                    </div>
                    <TextEditor
                        key={`text-editor-system-${nodeID}`}
                        nodeID={nodeID}
                        fieldName={key}
                        inputSchema={incomingSchema}
                        content={currentNodeConfig[key] || ''}
                        setContent={(value: string) => handleInputChange(key, value)}
                    />
                    {!isLast && <hr className="my-2" />}
                </div>
            )
        }

        if (key === 'user_message') {
            return (
                <div key={key}>
                    <div className="flex items-center gap-2 mb-2">
                        <h3 className="font-semibold">User Message</h3>
                        <Tooltip
                            content="The User Message is your main prompt template. Use variables like {{input.variable}} to make it dynamic. This is where you specify what you want the AI to do with each input it receives."
                            placement="left-start"
                            showArrow={true}
                            className="max-w-xs"
                        >
                            <Icon
                                icon="solar:question-circle-linear"
                                className="text-default-400 cursor-help"
                                width={20}
                            />
                        </Tooltip>
                    </div>
                    <TextEditor
                        key={`text-editor-user-${nodeID}`}
                        nodeID={nodeID}
                        fieldName={key}
                        inputSchema={incomingSchema}
                        content={currentNodeConfig[key] || ''}
                        setContent={(value) => handleInputChange(key, value)}
                    />
                    {renderFewShotExamples()}
                    {!isLast && <hr className="my-2" />}
                </div>
            )
        }

        if (key.endsWith('_prompt') || key.endsWith('_message') || key.endsWith('_template')) {
            return (
                <div key={key}>
                    <TextEditor
                        key={`text-editor-${nodeID}-${key}`}
                        nodeID={nodeID}
                        fieldName={key}
                        inputSchema={incomingSchema}
                        fieldTitle={key}
                        content={currentNodeConfig[key] || ''}
                        setContent={(value) => handleInputChange(key, value)}
                    />
                    {!isLast && <hr className="my-2" />}
                </div>
            )
        }

        if (key === 'code') {
            return (
                <CodeEditor
                    key={`code-editor-${nodeID}-${key}`}
                    code={value}
                    mode="python"
                    onChange={(newValue: string) => handleInputChange(key, newValue)}
                />
            )
        }

        if (key === 'input_map') {
            return renderInputMapField(key, value, incomingSchema, handleInputChange)
        }
        if (key === 'output_map') {
            return renderOutputMapField(key, value, incomingSchema, handleInputChange)
        }

        // Handle other types (string, number, boolean, object)
        switch (typeof field) {
            case 'string':
                return (
                    <div key={key} className="my-4">
                        <Textarea
                            key={`textarea-${nodeID}-${key}`}
                            fullWidth
                            label={fieldMetadata?.title || key}
                            value={value}
                            onChange={(e) => handleInputChange(key, e.target.value)}
                            placeholder="Enter your input"
                        />
                        {!isLast && <hr className="my-2" />}
                    </div>
                )
            case 'number':
                // Get current model constraints if this is a temperature or max_tokens field
                const currentModel = currentNodeConfig?.llm_info?.model
                const modelConstraints = currentModel ? getModelConstraints(nodeSchema, currentModel) : null

                let min = fieldMetadata?.minimum ?? 0
                let max = fieldMetadata?.maximum ?? 100

                // Override constraints based on model if available
                if (modelConstraints) {
                    if (key === 'temperature' || fullPath.endsWith('.temperature')) {
                        min = modelConstraints.min_temperature
                        max = modelConstraints.max_temperature
                        // Ensure value is within constraints
                        if (value < min) value = min
                        if (value > max) value = max
                    } else if (key === 'max_tokens' || fullPath.endsWith('.max_tokens')) {
                        max = modelConstraints.max_tokens
                        // Ensure value is within constraints
                        if (value > max) value = max
                    }
                }

                if (fieldMetadata && (min !== undefined || max !== undefined)) {
                    return (
                        <div key={key} className="my-4">
                            <div className="flex justify-between items-center mb-2">
                                <label className="font-semibold">{fieldMetadata.title || key}</label>
                                <span className="text-sm">{value}</span>
                            </div>
                            <Slider
                                key={`slider-${nodeID}-${key}`}
                                aria-label={fieldMetadata.title || key}
                                value={value}
                                minValue={min}
                                maxValue={max}
                                step={fieldMetadata.type === 'integer' ? 1 : 0.1}
                                className="w-full"
                                onChange={(newValue) => {
                                    const path = parentPath ? `${parentPath}.${key}` : key
                                    const lastTwoDots = path.split('.').slice(-2)
                                    const finalPath =
                                        lastTwoDots[0] === 'config' ? lastTwoDots[1] : lastTwoDots.join('.')
                                    handleInputChange(finalPath, newValue, true)
                                }}
                            />
                            {!isLast && <hr className="my-2" />}
                        </div>
                    )
                }
                return (
                    <NumberInput
                        key={`number-input-${nodeID}-${key}`}
                        label={key}
                        value={value}
                        onChange={(e) => {
                            const newValue = parseFloat(e.target.value)
                            handleInputChange(key, isNaN(newValue) ? 0 : newValue)
                        }}
                    />
                )
            case 'boolean':
                return (
                    <div key={key} className="my-4">
                        <div className="flex justify-between items-center">
                            <label className="font-semibold">{fieldMetadata?.title || key}</label>
                            <Switch
                                key={`switch-${nodeID}-${key}`}
                                isSelected={value}
                                onChange={(e) => handleInputChange(key, e.target.checked)}
                            />
                        </div>
                        {!isLast && <hr className="my-2" />}
                    </div>
                )
            case 'object':
                if (field && typeof field === 'object' && !Array.isArray(field)) {
                    return (
                        <div key={key} className="my-2">
                            {Object.keys(field).map((subKey) =>
                                renderField(subKey, field[subKey], value?.[subKey], fullPath)
                            )}
                            {!isLast && <hr className="my-2" />}
                        </div>
                    )
                }
                return null
            default:
                return null
        }
    }

    // Update renderConfigFields to include URL variable configuration
    const renderConfigFields = (): React.ReactNode => {
        if (!nodeSchema || !nodeSchema.config || !currentNodeConfig) return null
        const properties = nodeSchema.config
        const keys = Object.keys(properties).filter((key) => key !== 'title' && key !== 'type')

        // Prioritize system_message and user_message to appear first
        const priorityFields = ['system_message', 'user_message']
        const remainingKeys = keys.filter((key) => !priorityFields.includes(key))
        const orderedKeys = [...priorityFields.filter((key) => keys.includes(key)), ...remainingKeys]

        return (
            <React.Fragment>
                {orderedKeys.map((key, index) => {
                    const field = properties[key]
                    const value = currentNodeConfig[key]
                    const isLast = index === orderedKeys.length - 1
                    return renderField(key, field, value, `${nodeType}.config`, isLast)
                })}
                {renderUrlVariableConfig()}
            </React.Fragment>
        )
    }

    // Update the `renderFewShotExamples` function
    const renderFewShotExamples = () => {
        const fewShotExamples = nodeConfig?.few_shot_examples || []

        return (
            <div>
                {fewShotIndex !== null ? (
                    <FewShotEditor
                        key={`few-shot-editor-${nodeID}-${fewShotIndex}`}
                        nodeID={nodeID}
                        exampleIndex={fewShotIndex}
                        onSave={() => setFewShotIndex(null)}
                        onDiscard={() => setFewShotIndex(null)}
                    />
                ) : (
                    <div>
                        <div className="flex items-center gap-2 my-2">
                            <h3 className="font-semibold">Few Shot Examples</h3>
                            <Tooltip
                                content="Few-Shot prompting is a powerful technique where you provide example input-output pairs to help the AI understand the pattern you want it to follow. This significantly improves the quality and consistency of responses, especially for specific formats or complex tasks."
                                placement="left-start"
                                showArrow={true}
                                className="max-w-xs"
                            >
                                <Icon
                                    icon="solar:question-circle-linear"
                                    className="text-default-400 cursor-help"
                                    width={20}
                                />
                            </Tooltip>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {fewShotExamples.map((example, index) => (
                                <div
                                    key={`few-shot-${index}`}
                                    className="flex items-center space-x-2 p-2 bg-gray-100 rounded-full cursor-pointer"
                                    onClick={() => setFewShotIndex(index)}
                                >
                                    <span>Example {index + 1}</span>
                                    <Button
                                        isIconOnly
                                        radius="full"
                                        variant="light"
                                        onClick={(e) => {
                                            e.stopPropagation()
                                            handleDeleteExample(index)
                                        }}
                                        color="primary"
                                    >
                                        <Icon icon="solar:trash-bin-trash-linear" width={22} />
                                    </Button>
                                </div>
                            ))}

                            <Button
                                key={`add-example-${nodeID}`}
                                isIconOnly
                                radius="full"
                                variant="light"
                                onClick={handleAddNewExample}
                                color="primary"
                            >
                                <Icon icon="solar:add-circle-linear" width={22} />
                            </Button>
                        </div>
                    </div>
                )}
            </div>
        )
    }

    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        setIsResizing(true)
        e.preventDefault()
    }, [])

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (!isResizing) return

            const newWidth = window.innerWidth - e.clientX
            const constrainedWidth = Math.min(Math.max(newWidth, 300), 800)
            if (constrainedWidth === width) return
            setWidth(constrainedWidth)
        }

        const handleMouseUp = () => {
            setIsResizing(false)
            dispatch(setSidebarWidth(width))
        }

        if (isResizing) {
            window.addEventListener('mousemove', handleMouseMove)
            window.addEventListener('mouseup', handleMouseUp)
        }

        return () => {
            window.removeEventListener('mousemove', handleMouseMove)
            window.removeEventListener('mouseup', handleMouseUp)
        }
    }, [isResizing, dispatch, width])

    const renderUrlVariableConfig = () => {
        // Only show for LLM nodes with Gemini models
        if (!currentNodeConfig?.llm_info?.model || !String(currentNodeConfig.llm_info.model).startsWith('gemini')) {
            return null
        }

        const incomingSchemaVars = collectIncomingSchema(nodeID)

        return (
            <div className="my-4">
                <div className="flex items-center gap-2 mb-2">
                    <h3 className="font-semibold">File Input</h3>
                    <Tooltip
                        content="Select an input variable containing either a file URL or inline data. For inline data, use the format: data:<mime_type>;base64,<encoded_data> (e.g., data:image/jpeg;base64,/9j/...)"
                        placement="left-start"
                        showArrow={true}
                        className="max-w-xs"
                    >
                        <Icon icon="solar:question-circle-linear" className="text-default-400 cursor-help" width={20} />
                    </Tooltip>
                </div>
                <div className="mb-2">
                    <Select
                        label="File URL or Data Variable"
                        selectedKeys={[currentNodeConfig?.url_variables?.file || '']}
                        onChange={(e) => {
                            const updatedUrlVars = e.target.value ? { file: e.target.value } : {}
                            handleInputChange('url_variables', updatedUrlVars)
                        }}
                    >
                        {['', ...incomingSchemaVars].map((variable) => (
                            <SelectItem key={variable} value={variable}>
                                {variable || 'None'}
                            </SelectItem>
                        ))}
                    </Select>
                    <p className="text-xs text-default-500 mt-1">
                        Supports both file URLs and inline data in the format:
                        data:&lt;mime_type&gt;;base64,&lt;encoded_data&gt;
                    </p>
                </div>
            </div>
        )
    }

    const renderInputMapField = (
        key: string,
        value: any,
        incomingSchema: string[],
        handleInputChange: (key: string, value: any) => void
    ) => {
        return (
            <div key={key} className="my-2">
                <div className="flex items-center gap-2 mb-2">
                    <h3 className="font-semibold">Input Mapping</h3>
                    <Tooltip
                        content="Map input fields from predecessor nodes to this node's input schema. Use the dropdown to select available fields from connected nodes."
                        placement="left-start"
                        showArrow={true}
                        className="max-w-xs"
                    >
                        <Icon icon="solar:question-circle-linear" className="text-default-400 cursor-help" width={20} />
                    </Tooltip>
                </div>
                <SchemaEditor
                    key={`input-map-editor-${nodeID}`}
                    jsonValue={value || {}}
                    onChange={(newValue) => handleInputChange(key, newValue)}
                    options={jsonOptions}
                    schemaType="input_map"
                    nodeId={nodeID}
                    availableFields={incomingSchema}
                />
            </div>
        )
    }

    const renderOutputMapField = (
        key: string,
        value: any,
        incomingSchema: string[],
        handleInputChange: (key: string, value: any) => void
    ) => {
        return (
            <div key={key} className="my-2">
                <div className="flex items-center gap-2 mb-2">
                    <h3 className="font-semibold">Output Mapping</h3>
                    <Tooltip
                        content="Map fields from this node's output schema to the incoming variables of this node"
                        placement="left-start"
                        showArrow={true}
                        className="max-w-xs"
                    >
                        <Icon icon="solar:question-circle-linear" className="text-default-400 cursor-help" width={20} />
                    </Tooltip>
                </div>
                <SchemaEditor
                    key={`output-map-editor-${nodeID}`}
                    jsonValue={value || {}}
                    onChange={(newValue) => handleInputChange(key, newValue)}
                    options={jsonOptions}
                    schemaType="output_map"
                    nodeId={nodeID}
                    availableFields={incomingSchema}
                />
            </div>
        )
    }

    return (
        <Card
            className="fixed top-16 bottom-4 right-4 p-4 rounded-xl border border-solid border-default-200 overflow-auto"
            style={{ width: `${width}px` }}
        >
            {showTitleError && (
                <Alert
                    key={`alert-${nodeID}`}
                    className="absolute top-4 left-4 right-4 z-50"
                    color="danger"
                    onClose={() => setShowTitleError(false)}
                >
                    Title cannot contain whitespace. Use underscores instead.
                </Alert>
            )}
            <div
                className="absolute top-0 right-0 h-full flex"
                style={{
                    width: '100%',
                    zIndex: 2,
                    userSelect: isResizing ? 'none' : 'auto',
                }}
            >
                <div
                    className="absolute left-0 top-0 h-full w-1 cursor-ew-resize transition-colors duration-200"
                    onMouseDown={handleMouseDown}
                    style={{
                        backgroundColor: isResizing ? 'var(--heroui-colors-primary)' : undefined,
                        opacity: isResizing ? 1 : 0,
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
                    onMouseLeave={(e) => !isResizing && (e.currentTarget.style.opacity = '0')}
                />

                <div className="flex-1 px-6 py-1 overflow-auto max-h-screen" id="node-details">
                    <div className="flex justify-between items-center mb-2">
                        <div>
                            <h1 className="text-lg font-semibold">{nodeConfig?.title || node?.id || 'Node Details'}</h1>
                            <h2 className="text-xs font-semibold">{nodeType}</h2>
                        </div>
                        <Button
                            key={`close-btn-${nodeID}`}
                            isIconOnly
                            radius="full"
                            variant="light"
                            onClick={() => dispatch(setSelectedNode({ nodeId: null }))}
                        >
                            <Icon
                                key={`close-icon-${nodeID}`}
                                className="text-default-500"
                                icon="solar:close-circle-linear"
                                width={24}
                            />
                        </Button>
                    </div>

                    <Accordion
                        key={`accordion-${nodeID}`}
                        selectionMode="multiple"
                        defaultExpandedKeys={hasRunOutput ? ['output'] : ['title', 'config']}
                    >
                        <AccordionItem key="output" aria-label="Output" title="Outputs">
                            <NodeOutput key={`node-output-${nodeID}`} output={node?.data?.run} />
                        </AccordionItem>
                        <AccordionItem key="config" aria-label="Node Configuration" title="Node Configuration">
                            <Input
                                key={`title-input-${nodeID}`}
                                defaultValue={nodeConfig?.title || node?.id || ''}
                                onBlur={(e) => handleTitleChangeComplete(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        e.currentTarget.blur()
                                    }
                                }}
                                placeholder="Enter node title"
                                label="Node Title"
                                fullWidth
                                description="Use underscores instead of spaces"
                            />
                            <hr className="my-2" />
                            {renderConfigFields()}
                        </AccordionItem>
                    </Accordion>
                </div>
            </div>
        </Card>
    )
}

export default NodeSidebar
