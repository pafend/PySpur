import { FlowWorkflowNode, FlowWorkflowNodeConfig, Position } from '@/store/flowSlice'
import cloneDeep from 'lodash/cloneDeep'
import { FlowWorkflowNodeType, FlowWorkflowNodeTypesByCategory } from '@/store/nodeTypesSlice'

// Function to create a node based on its type
export const createNode = (
    nodeTypes: FlowWorkflowNodeTypesByCategory,
    type: string,
    id: string,
    position: Position,
    parentId: string | null = null,
    dimensions: { width: number; height: number } | null = null
): { node: FlowWorkflowNode; config: FlowWorkflowNodeConfig } | null => {
    let nodeType: FlowWorkflowNodeType | null = null
    for (const category in nodeTypes) {
        const found = nodeTypes[category].find((node) => node.name === type)
        if (found) {
            nodeType = found
            break
        }
    }
    if (!nodeType) {
        return null
    }

    let config = cloneDeep(nodeType.config)
    config = {
        ...config,
        title: id,
    }
    const extent = parentId ? 'parent' : undefined
    const expandParent = parentId ? true : undefined

    const node: FlowWorkflowNode = {
        id,
        type: nodeType.name,
        position,
        measured: dimensions,
        parentId,
        expandParent,
        extent,
        data: {
            title: id,
            acronym: nodeType.visual_tag.acronym,
            color: nodeType.visual_tag.color,
            logo: nodeType.logo,
            category: nodeType.category,
        },
        width: dimensions?.width,
        height: dimensions?.height,
    }
    return { node, config }
}
